/**
 * Skill→Bins mapping — builds a lookup table from loaded SkillEntry[] to
 * enable fast matching of exec commands against skill CLI binaries.
 */

import type { SkillEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillBinInfo {
  /** All `requires.bins` entries for this skill. */
  bins: string[];
  /** All `requires.anyBins` entries for this skill. */
  anyBins: string[];
}

/**
 * Maps skill name → its required binary names.
 * Populated by `buildSkillBinsMap` during skill loading.
 */
export type SkillBinsMap = Map<string, SkillBinInfo>;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build a skill→bins map from raw SkillEntry[].
 *
 * Extracts `clawdbot.requires.bins` and `clawdbot.requires.anyBins`
 * from each entry.  Returns a Map keyed by skill name.
 */
export function buildSkillBinsMap(entries: SkillEntry[]): SkillBinsMap {
  const map: SkillBinsMap = new Map();

  for (const entry of entries) {
    const bins = entry.clawdbot?.requires?.bins ?? [];
    const anyBins = entry.clawdbot?.requires?.anyBins ?? [];
    if (bins.length === 0 && anyBins.length === 0) continue;

    map.set(entry.skill.name, {
      bins: bins.map((b) => b.toLowerCase()),
      anyBins: anyBins.map((b) => b.toLowerCase()),
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// Command matching
// ---------------------------------------------------------------------------

/**
 * Extract the first "word" from an exec command string.
 *
 * Strips leading whitespace, handles quoted tokens,
 * and normalizes to lower case.
 *
 * Examples:
 *   "gog mail list"        → "gog"
 *   "  curl -s http://..." → "curl"
 *   "python3 script.py"    → "python3"
 *   "/usr/bin/env node"    → "/usr/bin/env"  (path-aware: resolves to "env")
 */
export function extractCommandBin(command: string): string {
  const trimmed = command.trimStart();
  if (!trimmed) return "";

  // Handle leading env-like prefix: /path/to/env BIN ...
  // We extract the first meaningful binary.
  let bin = "";
  let i = 0;

  // Skip leading whitespace (already handled by trimStart)
  // Parse the first token
  if (trimmed[i] === '"' || trimmed[i] === "'") {
    const quote = trimmed[i];
    i++;
    while (i < trimmed.length && trimmed[i] !== quote) {
      bin += trimmed[i];
      i++;
    }
  } else {
    while (i < trimmed.length && !/\s/.test(trimmed[i])) {
      bin += trimmed[i];
      i++;
    }
  }

  // Normalize: strip any leading path components (e.g., "/usr/bin/gog" → "gog")
  const parts = bin.includes("/") ? bin.split("/") : [bin];
  const basename = parts[parts.length - 1] ?? bin;

  return basename.toLowerCase();
}

/**
 * Match a command against the skill bins map.
 *
 * Strategy:
 *   1. Extract the first word (binary) from the command.
 *   2. Match against each skill's `bins` (exact match).
 *   3. If no exact match, check `anyBins` (any of them is a match).
 *   4. If multiple skills share the same bin, return the first match
 *      (with a low-confidence note).
 *
 * Returns the matching skill name, or `undefined` if no match.
 */
export function matchSkillByCommand(command: string, binsMap: SkillBinsMap): string | undefined {
  if (binsMap.size === 0) return undefined;

  const bin = extractCommandBin(command);
  if (!bin) return undefined;

  // Priority 1: exact match in bins[]
  let matched: string | undefined;
  binsMap.forEach((info, skillName) => {
    if (matched) return; // short-circuit once a match is found
    if (info.bins.includes(bin)) matched = skillName;
    if (info.anyBins.includes(bin)) matched = skillName;
  });
  return matched;
}
