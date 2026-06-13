/* ============================================================
   FootLive — Football & Cricket streaming
   Merges two video sources:
     Server N (WatchFooty): direct embed URL in match.streams[]
     Server N (Streamed.pk): fetched via /api/stream/[source]/[id]
   ============================================================ */

const WF_API = "https://api.watchfooty.st";
const SK_API = "https://streamed.pk";
const SK_IMG = `${SK_API}/api/images`;

/* ------------------------------------------------------------
   Popup/Ad blocker
   The iframe sandbox (no allow-popups) already blocks new tabs
   spawned from inside the embed. This JS layer adds a second
   line of defense at the page level.
   ------------------------------------------------------------ */
// 1) Neutralize window.open globally — any ad script that calls
//    window.open() will get a no-op instead of a new tab.
window.open = function () {
  return null;
};

// 2) Intercept clicks that try to open new tabs/windows (capture phase)
document.addEventListener(
  "click",
  (e) => {
    const a = e.target.closest("a[target]");
    if (a && (a.target === "_blank" || a.target === "_new")) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

// Elements
const $matches = document.getElementById("matches");
const $status = document.getElementById("status");
const $filters = document.getElementById("sportFilters");
const $refresh = document.getElementById("refreshBtn");
const $playerSection = document.getElementById("playerSection");
const $player = document.getElementById("streamPlayer");
const $streamInfo = document.getElementById("streamInfo");
const $streamOptions = document.getElementById("streamOptions");
const $closePlayer = document.getElementById("closePlayer");
const $nextServer = document.getElementById("nextServerBtn");
const $streamHint = document.getElementById("streamHint");

// State
let allMatches = []; // normalized matches
let activeSport = "all";
let currentStreams = []; // streams for the open match
let currentIdx = 0; // index of currently playing stream
let hintTimer = null;
const ALLOWED_SPORTS = ["football", "cricket"];
const FALLBACK_SPORTS = [
  { id: "football", name: "Football" },
  { id: "cricket", name: "Cricket" },
];
let sports = [];

/* ------------------------------------------------------------
   Helpers
   ------------------------------------------------------------ */
async function getJSON(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${baseUrl}${path}`);
  return res.json();
}

function escapeHtml(str = "") {
  const a = String.fromCharCode(38); // &
  const map = {};
  map[38] = a + "amp;";
  map[60] = a + "lt;";
  map[62] = a + "gt;";
  map[34] = a + "quot;";
  map[39] = a + "#39;";
  return String(str).replace(/[&<>"']/g, (c) => map[c.charCodeAt(0)]);
}

function titleKey(title = "") {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

function initials(name = "") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function wfLogoUrl(path) {
  if (!path) return "";
  return path.startsWith("http") ? path : `${WF_API}${path}`;
}

function badgeHtml(team) {
  if (!team) return `<div class="badge-text">?</div>`;
  const { name = "" } = team;
  const wfLogo = wfLogoUrl(team.logoUrl);
  const skBadge = team.badge ? `${SK_IMG}/badge/${team.badge}.webp` : "";
  if (wfLogo) {
    return `<img class="badge" src="${escapeHtml(
      wfLogo,
    )}" alt="${escapeHtml(name)}" loading="lazy" data-fallback="${escapeHtml(
      initials(name),
    )}"/>`;
  }
  if (skBadge) {
    return `<img class="badge" src="${escapeHtml(
      skBadge,
    )}" alt="${escapeHtml(name)}" loading="lazy" data-fallback="${escapeHtml(
      initials(name),
    )}"/>`;
  }
  return `<div class="badge-text" title="${escapeHtml(name)}">${escapeHtml(
    initials(name),
  )}</div>`;
}

function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle("error", isError);
}

function showLoading(isLoading) {
  $refresh.classList.toggle("loading", isLoading);
}

/* ------------------------------------------------------------
   Normalize matches from both APIs into a common shape
   ------------------------------------------------------------ */
// WatchFooty match -> normalized
function normWf(m) {
  const streams = (m.streams || []).map((s, i) => ({
    serverName: `Server ${i + 1}`,
    language: s.language || "",
    hd: /hd|1080|720/i.test(s.quality || ""),
    embedUrl: s.url,
    origin: "watchfooty",
  }));
  return {
    id: `wf-${m.matchId}`,
    title: m.title || "Untitled",
    category: m.sport || "other",
    home: m.teams?.home
      ? { name: m.teams.home.name, logoUrl: m.teams.home.logoUrl }
      : null,
    away: m.teams?.away
      ? { name: m.teams.away.name, logoUrl: m.teams.away.logoUrl }
      : null,
    score: m.scores ? `${m.scores.home ?? ""} - ${m.scores.away ?? ""}` : "",
    minute: m.currentMinute || "",
    wfStreams: streams,
    skSources: [],
  };
}

// Streamed.pk match -> normalized
function normSk(m) {
  return {
    id: `sk-${m.id}`,
    title: m.title || "Untitled",
    category: m.category || "other",
    home: m.teams?.home
      ? { name: m.teams.home.name, badge: m.teams.home.badge }
      : null,
    away: m.teams?.away
      ? { name: m.teams.away.name, badge: m.teams.away.badge }
      : null,
    score: "",
    minute: "",
    wfStreams: [],
    skSources: m.sources || [],
  };
}

/* ------------------------------------------------------------
   Merge by title — prefer WatchFooty (scores), append SK sources
   ------------------------------------------------------------ */
function mergeMatches(wfList, skList) {
  const map = new Map();
  wfList.forEach((m) => map.set(titleKey(m.title), m));
  skList.forEach((m) => {
    const key = titleKey(m.title);
    if (map.has(key)) {
      // Append streamed.pk sources to the existing match
      map.get(key).skSources = m.skSources;
    } else {
      map.set(key, m);
    }
  });
  // Sort: with streams first, then alphabetical
  return Array.from(map.values()).sort((a, b) => {
    const ac = (a.wfStreams?.length || 0) + (a.skSources?.length || 0);
    const bc = (b.wfStreams?.length || 0) + (b.skSources?.length || 0);
    if (bc !== ac) return bc - ac;
    return a.title.localeCompare(b.title);
  });
}

/* ------------------------------------------------------------
   Init
   ------------------------------------------------------------ */
async function init() {
  renderFilters();
  await loadMatches();
}

function renderFilters() {
  const all = [{ id: "all", name: "All" }, ...FALLBACK_SPORTS];
  $filters.innerHTML = all
    .map(
      (s) =>
        `<button data-sport="${s.id}" class="${
          s.id === activeSport ? "active" : ""
        }">${escapeHtml(s.name)}</button>`,
    )
    .join("");

  $filters.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeSport = btn.dataset.sport;
      $filters
        .querySelectorAll("button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderMatches();
    });
  });
}

async function loadMatches() {
  showLoading(true);
  setStatus("Fetching live matches from all sources…");
  try {
    // Fetch both APIs in parallel
    const [wfRes, skRes] = await Promise.allSettled([
      getJSON(WF_API, "/api/v1/matches/live"),
      getJSON(SK_API, "/api/matches/live"),
    ]);

    const wfRaw =
      wfRes.status === "fulfilled" && Array.isArray(wfRes.value)
        ? wfRes.value
        : [];
    const skRaw =
      skRes.status === "fulfilled" && Array.isArray(skRes.value)
        ? skRes.value
        : [];

    const wfFiltered = wfRaw
      .filter((m) => ALLOWED_SPORTS.includes(m.sport))
      .map(normWf);
    const skFiltered = skRaw
      .filter((m) => ALLOWED_SPORTS.includes(m.category))
      .map(normSk);

    allMatches = mergeMatches(wfFiltered, skFiltered);
    renderMatches();

    if (allMatches.length === 0) {
      setStatus("No live football or cricket matches right now.");
    } else {
      $status.textContent = "";
    }
  } catch (e) {
    setStatus("Could not load matches. (" + e.message + ")", true);
    allMatches = [];
    renderMatches();
  } finally {
    showLoading(false);
  }
}

/* ------------------------------------------------------------
   Render matches
   ------------------------------------------------------------ */
function renderMatches() {
  const allowed = allMatches.filter((m) => ALLOWED_SPORTS.includes(m.category));
  const list =
    activeSport === "all"
      ? allowed
      : allowed.filter((m) => m.category === activeSport);

  if (list.length === 0) {
    $matches.innerHTML = "";
    setStatus(
      activeSport === "all"
        ? "No live football or cricket matches right now."
        : `No live ${activeSport} matches right now.`,
    );
    return;
  }
  $status.textContent = "";

  $matches.innerHTML = list
    .map((m) => {
      const wfCount = m.wfStreams?.length || 0;
      const skCount = m.skSources?.length || 0;
      const total = wfCount + skCount;
      const noSource = total === 0;

      const homeBadge = badgeHtml(m.home);
      const awayBadge = badgeHtml(m.away);

      const scoreHtml = m.score
        ? `<span class="score">${escapeHtml(m.score)}</span>`
        : "";
      const minuteHtml = m.minute
        ? `<span class="minute">${escapeHtml(m.minute)}</span>`
        : "";

      return `
      <article class="match-card ${noSource ? "hidden-source" : ""}"
               data-id="${escapeHtml(m.id)}"
               role="button"
               tabindex="0">
        <div class="match-poster">
          <span class="live-badge">LIVE</span>
          ${homeBadge}
          <div class="vs-col">
            <span class="vs">VS</span>
            ${scoreHtml}
            ${minuteHtml}
          </div>
          ${awayBadge}
        </div>
        <div class="match-body">
          <div class="match-title">${escapeHtml(m.title || "Untitled match")}</div>
          <div class="match-meta">
            <span class="sport-tag">${escapeHtml(m.category || "sport")}</span>
            <span class="source-count">${total} server${total === 1 ? "" : "s"}</span>
          </div>
        </div>
      </article>`;
    })
    .join("");

  $matches.querySelectorAll(".match-card").forEach((card) => {
    const handler = () => openMatch(card.dataset.id);
    card.addEventListener("click", handler);
    card.addEventListener("keypress", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler();
      }
    });
  });

  $matches.querySelectorAll("img.badge[data-fallback]").forEach((img) => {
    img.addEventListener("error", () => {
      const span = document.createElement("div");
      span.className = "badge-text";
      span.textContent = img.dataset.fallback || "?";
      img.replaceWith(span);
    });
  });
}

/* ------------------------------------------------------------
   Open a match -> gather all streams -> play first
   ------------------------------------------------------------ */
async function openMatch(id) {
  const match = allMatches.find((m) => m.id === id);
  if (!match) return;

  $streamInfo.innerHTML = `Loading streams for <strong>${escapeHtml(
    match.title,
  )}</strong>…`;
  $streamOptions.innerHTML = "";
  $streamHint.textContent = "";
  $nextServer.style.display = "none";
  $player.src = "about:blank";
  $playerSection.classList.remove("hidden");
  $playerSection.scrollIntoView({ behavior: "smooth", block: "start" });

  // 1) WatchFooty streams (already have embed URLs)
  const streams = [...(match.wfStreams || [])];

  // 2) Streamed.pk streams (fetch per source, continue numbering after WF)
  if (match.skSources && match.skSources.length) {
    const results = await Promise.allSettled(
      match.skSources.map(async (src) => {
        const arr = await getJSON(
          SK_API,
          `/api/stream/${src.source}/${encodeURIComponent(src.id)}`,
        );
        return (Array.isArray(arr) ? arr : []).map((s) => ({
          embedUrl: s.embedUrl,
          language: s.language || "",
          hd: !!s.hd,
          origin: "streamed",
        }));
      }),
    );
    results.forEach((r) => {
      if (r.status === "fulfilled" && r.value.length) {
        r.value.forEach((s) => {
          streams.push({
            serverName: `Server ${streams.length + 1}`,
            language: s.language,
            hd: s.hd,
            embedUrl: s.embedUrl,
            origin: s.origin,
          });
        });
      }
    });
  }

  // Sort: HD + English first
  streams.sort((a, b) => {
    const score = (s) =>
      (s.hd ? 2 : 0) + (/english/i.test(s.language || "") ? 1 : 0);
    return score(b) - score(a);
  });

  if (streams.length === 0) {
    $streamInfo.textContent = "No playable streams were found for this match.";
    return;
  }

  renderStreamOptions(streams, match);
  playStream(streams[0]);
  startHintTimer();
}

function renderStreamOptions(streams, match) {
  currentStreams = streams;
  currentIdx = 0;

  $streamInfo.innerHTML = `Now playing: <strong>${escapeHtml(
    match.title,
  )}</strong> &middot; ${streams.length} server${
    streams.length === 1 ? "" : "s"
  }`;

  $streamOptions.innerHTML = streams
    .map((s, i) => {
      const lang = s.language ? ` · ${escapeHtml(s.language)}` : "";
      return `
        <button data-idx="${i}" class="${i === 0 ? "active" : ""}">
          ${escapeHtml(s.serverName)}${lang}
          ${s.hd ? '<span class="hd-chip">HD</span>' : ""}
        </button>`;
    })
    .join("");

  $streamOptions.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectStream(Number(btn.dataset.idx));
    });
  });

  updateNextServerBtn();
}

function selectStream(idx) {
  if (!currentStreams.length) return;
  currentIdx =
    ((idx % currentStreams.length) + currentStreams.length) %
    currentStreams.length;
  $streamOptions
    .querySelectorAll("button")
    .forEach((b) => b.classList.remove("active"));
  const activeBtn = $streamOptions.querySelector(
    `button[data-idx="${currentIdx}"]`,
  );
  if (activeBtn) activeBtn.classList.add("active");
  playStream(currentStreams[currentIdx]);
  updateNextServerBtn();
}

function playStream(stream) {
  if (!stream?.embedUrl) return;
  // Recreate the iframe fresh on each play so no leftover ad state
  // can persist between stream switches.
  const parent = $player.parentElement;
  const fresh = document.createElement("iframe");
  fresh.id = $player.id;
  fresh.src = stream.embedUrl;
  fresh.width = "100%";
  fresh.height = "100%";
  fresh.frameBorder = "0";
  fresh.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
  fresh.allowFullscreen = true;
  fresh.referrerPolicy = "no-referrer";
  parent.replaceChild(fresh, $player);
  $player = fresh;
}

function updateNextServerBtn() {
  if (currentStreams.length <= 1) {
    $nextServer.style.display = "none";
    return;
  }
  $nextServer.style.display = "";
  const next =
    currentStreams[(currentIdx + 1) % currentStreams.length]?.serverName ||
    "Next";
  // Update label text but keep the SVG icon
  const label = $nextServer.querySelector(".next-label");
  if (label) label.textContent = `Next Server (${next})`;
}

function showStreamHint() {
  if (currentStreams.length > 1) {
    $streamHint.innerHTML =
      'Video not loading or showing an error? That server may be geo-blocked or offline. Tap <strong>"Next Server"</strong> above to try another source.';
  }
}

function startHintTimer() {
  clearTimeout(hintTimer);
  $streamHint.textContent = "";
  hintTimer = setTimeout(showStreamHint, 7000);
}

/* ------------------------------------------------------------
   Events
   ------------------------------------------------------------ */
$refresh.addEventListener("click", loadMatches);

$closePlayer.addEventListener("click", () => {
  $player.src = "about:blank";
  $playerSection.classList.add("hidden");
  currentStreams = [];
  currentIdx = 0;
  clearTimeout(hintTimer);
});

$nextServer.addEventListener("click", () => {
  if (currentStreams.length > 1) {
    selectStream(currentIdx + 1);
  }
});

// Auto-refresh matches every 60s
setInterval(loadMatches, 60000);

// Start
init();
