/**
 * Generic HTTP(S) CSV fetch: pass full URLs only (any host).
 * Use for ad-hoc mirrors or datasets not covered by other sources.
 */

export const SOURCE_ID = "http-csv";
export const SOURCE_LABEL = "HTTP CSV (explicit URLs)";
export const MANIFEST_SOURCE = "http-csv";
export const NOTES_URL = "https://www.iana.org/assignments/media-types/text/csv";
export const DEFAULT_USER_AGENT =
  "OpenClaw-football-local-data/1.0 (+https://github.com/openclaw/openclaw; http-csv)";

/**
 * @param {object} args
 * @param {{ combined?: boolean }} [ctx] combined=true when also fetching another source (e.g. football-data-co-uk uses --preset).
 */
export function validateArgs(args, ctx = {}) {
  if (!args.urls?.length) {
    throw new Error("http-csv: provide at least one URL via --urls");
  }
  if (ctx.combined) {
    return;
  }
  if (args.preset || args.leagues?.length || args.seasonRange || args.seasonsList?.length > 0) {
    throw new Error(
      "http-csv: use only --urls (and optional --season for manifest label), not --preset/--leagues/--season-range/--seasons",
    );
  }
}

/**
 * Single batch; optional --season labels the manifest folder code.
 * @param {object} args
 */
export function resolveSeasons(args) {
  return [args.season ? String(args.season).trim() : "manual"];
}

/**
 * @param {object} args
 * @param {string} _season
 */
export function buildUrlsForSeason(args, _season) {
  return [...args.urls];
}
