/**
 * Football-Data.co.uk — CSV URL helpers and URL building.
 * @see https://www.football-data.co.uk/
 * @see https://www.football-data.co.uk/notes.txt
 */

export const SOURCE_ID = "football-data-co-uk";
export const SOURCE_LABEL = "Football-Data.co.uk";
export const MANIFEST_SOURCE = "football-data.co.uk";
export const NOTES_URL = "https://www.football-data.co.uk/notes.txt";
export const DEFAULT_USER_AGENT =
  "OpenClaw-football-local-data/1.0 (+https://github.com/openclaw/openclaw; football-data-co-uk)";

const BASE = "https://www.football-data.co.uk/mmz4281";

/**
 * Season folder code: 2025/26 → "2526", 2024/25 → "2425".
 * Assumes European season starting ~August (Aug–Dec = start year / next year; Jan–Jul = prev / current).
 */
export function seasonCodeFromDate(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  if (m >= 8) {
    const a = y % 100;
    const b = (y + 1) % 100;
    return `${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`;
  }
  const a = (y - 1) % 100;
  const b = y % 100;
  return `${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`;
}

/** @param {string} seasonCode e.g. "2526" */
export function csvUrl(seasonCode, leagueFile) {
  const f = leagueFile.endsWith(".csv") ? leagueFile : `${leagueFile}.csv`;
  return `${BASE}/${seasonCode}/${f}`;
}

export function seasonCodeFromStartYear(startYear) {
  const a = startYear % 100;
  const b = (startYear + 1) % 100;
  return `${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`;
}

export function enumerateSeasonCodesFromStartYears(startYear, endYear) {
  const lo = Math.min(startYear, endYear);
  const hi = Math.max(startYear, endYear);
  const out = [];
  for (let y = lo; y <= hi; y++) {
    out.push(seasonCodeFromStartYear(y));
  }
  return out;
}

export const PRESET_LEAGUES = {
  england: ["E0", "E1", "E2", "E3", "EC"],
  scotland: ["SC0", "SC1", "SC2", "SC3"],
  germany: ["D1", "D2"],
  italy: ["I1", "I2"],
  spain: ["SP1", "SP2"],
  france: ["F1", "F2"],
  netherlands: ["N1"],
  belgium: ["B1"],
  portugal: ["P1"],
  turkey: ["T1"],
  greece: ["G1"],
};

export function allPresetLeagueStems() {
  const seen = new Set();
  const out = [];
  for (const arr of Object.values(PRESET_LEAGUES)) {
    for (const s of arr) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

export function expandPreset(name) {
  const k = String(name ?? "")
    .trim()
    .toLowerCase();
  if (k === "all") {
    return allPresetLeagueStems();
  }
  return PRESET_LEAGUES[k] ? [...PRESET_LEAGUES[k]] : null;
}

/**
 * @param {object} args
 * @returns {string[]}
 */
export function resolveSeasons(args) {
  const hasSeason = Boolean(args.season);
  const hasRange = Boolean(args.seasonRange);
  const hasList = args.seasonsList.length > 0;
  const n = [hasSeason, hasRange, hasList].filter(Boolean).length;
  if (n > 1) {
    throw new Error("Use only one of --season, --season-range, or --seasons");
  }
  if (hasRange) {
    const raw = String(args.seasonRange).trim();
    const parts = raw.split("-").map((s) => s.trim());
    if (parts.length !== 2) {
      throw new Error(`--season-range must look like 1993-2025, got: ${args.seasonRange}`);
    }
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error(`--season-range needs numeric years, got: ${args.seasonRange}`);
    }
    return enumerateSeasonCodesFromStartYears(a, b);
  }
  if (hasList) {
    return [...args.seasonsList];
  }
  if (hasSeason) {
    return [String(args.season).trim()];
  }
  return [seasonCodeFromDate()];
}

/**
 * @param {object} args
 * @param {string} season
 * @returns {string[]}
 */
export function buildUrlsForSeason(args, season) {
  /** @type {string[]} */
  let urls = [...args.urls];

  if (args.preset) {
    const list = expandPreset(args.preset);
    if (!list) {
      throw new Error(`Unknown --preset "${args.preset}". See --help.`);
    }
    for (const stem of list) {
      urls.push(csvUrl(season, stem));
    }
  }
  for (const stem of args.leagues) {
    urls.push(csvUrl(season, stem));
  }

  return [...new Set(urls)];
}

/**
 * @param {object} args
 */
export function validateArgs(args) {
  const hasManualUrls = args.urls.length > 0;
  const hasPresetOrLeagues = Boolean(args.preset) || args.leagues.length > 0;
  if (hasManualUrls && hasPresetOrLeagues) {
    throw new Error("Use either --urls alone, or --preset/--leagues (not both).");
  }
  if (hasManualUrls) {
    if (args.seasonRange || args.seasonsList.length > 0) {
      throw new Error("--urls cannot be combined with --season-range or --seasons.");
    }
  }
}
