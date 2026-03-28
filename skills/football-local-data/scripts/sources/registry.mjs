/**
 * Register local CSV data sources. Add a new module under ./ and import it here.
 */

import * as fbref from "./fbref.mjs";
import * as footballDataCoUk from "./football-data-co-uk.mjs";
import * as httpCsv from "./http-csv.mjs";

/** @type {Record<string, typeof footballDataCoUk>} */
export const SOURCE_REGISTRY = {
  "football-data-co-uk": footballDataCoUk,
  "http-csv": httpCsv,
  fbref,
};

export function listSourceIds() {
  return Object.keys(SOURCE_REGISTRY).sort();
}

/** Sources that can run without extra per-source flags (excludes http-csv, which needs --urls). */
export function allAutoSourceIds() {
  return listSourceIds().filter((id) => id !== "http-csv" && id !== "fbref");
}

/**
 * @param {string} csv comma- or semicolon-separated ids, or "all"
 * @returns {string[]} deduped canonical ids
 */
export function parseSourcesList(csv) {
  const seen = new Set();
  const out = [];
  const parts = String(csv ?? "")
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (parts.includes("all")) {
    return [...allAutoSourceIds()];
  }

  for (const p of parts) {
    if (!SOURCE_REGISTRY[p]) {
      throw new Error(`Unknown source "${p}". Expected: ${listSourceIds().join(", ")}, or all`);
    }
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
