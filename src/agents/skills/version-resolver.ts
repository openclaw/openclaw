// RI-014 — Skill version + variant resolver
//
// Given a set of on-disk `SkillEntry` records for a single logical skill
// (same name, potentially different version/variant), pick the one the
// runtime should actually render into the system prompt for this run.
//
// Selection precedence:
//   1. If an AssignedVariant was provided (from the Quinn-Co experiment
//      service), prefer the entry whose (variantId, version) matches.
//      Fall back to (variantId only) → (version only) → control entry.
//   2. Otherwise return the entry marked as "control" if one exists, else
//      the highest-semver entry, else the first entry in the input list.
//
// Kept pure + synchronous on purpose: the call site (`skills-runtime.ts`)
// already does its async work, and version-resolver is trivially unit
// testable when it takes data in and returns data out.

import type { SkillEntry } from "./types.js";

export interface AssignedVariantLike {
  variant_id: string;
  skill_version: string;
  experiment_id: string | null;
  is_control: boolean;
}

export interface ResolvedSkillChoice {
  entry: SkillEntry;
  reason:
    | "variant-and-version-match"
    | "variant-only-match"
    | "version-only-match"
    | "control-entry"
    | "highest-version"
    | "first-entry";
  variantId?: string;
  version?: string;
  experimentId?: string | null;
}

/**
 * Group a flat list of skill entries by their logical skill name (the
 * pi-coding-agent `skill.name` value). Entries belonging to the same logical
 * skill but different variant/version collapse into one bucket.
 */
export function groupSkillEntriesByName(
  entries: SkillEntry[],
): Map<string, SkillEntry[]> {
  const out = new Map<string, SkillEntry[]>();
  for (const entry of entries) {
    const name = entry.skill.name;
    const bucket = out.get(name);
    if (bucket) {
      bucket.push(entry);
    } else {
      out.set(name, [entry]);
    }
  }
  return out;
}

/**
 * Resolve which entry in a group the runtime should render. Accepts an
 * optional AssignedVariant from the experiment service; falls back to
 * deterministic control-or-highest-version when none is supplied.
 */
export function resolveSkillVariant(
  bucket: SkillEntry[],
  assigned: AssignedVariantLike | null,
): ResolvedSkillChoice {
  if (bucket.length === 0) {
    throw new Error("resolveSkillVariant called with empty bucket");
  }
  if (bucket.length === 1) {
    const entry = bucket[0];
    return {
      entry,
      reason: "first-entry",
      variantId: entry.metadata?.variantId,
      version: entry.metadata?.version,
      experimentId: entry.metadata?.experimentId,
    };
  }

  // 1. Assigned variant — try to match both variant and version, then relax.
  if (assigned && !assigned.is_control) {
    const bothMatch = bucket.find(
      (e) =>
        e.metadata?.variantId === assigned.variant_id &&
        e.metadata?.version === assigned.skill_version,
    );
    if (bothMatch) {
      return {
        entry: bothMatch,
        reason: "variant-and-version-match",
        variantId: bothMatch.metadata?.variantId,
        version: bothMatch.metadata?.version,
        experimentId: bothMatch.metadata?.experimentId,
      };
    }
    const variantMatch = bucket.find(
      (e) => e.metadata?.variantId === assigned.variant_id,
    );
    if (variantMatch) {
      return {
        entry: variantMatch,
        reason: "variant-only-match",
        variantId: variantMatch.metadata?.variantId,
        version: variantMatch.metadata?.version,
        experimentId: variantMatch.metadata?.experimentId,
      };
    }
    const versionMatch = bucket.find(
      (e) => e.metadata?.version === assigned.skill_version,
    );
    if (versionMatch) {
      return {
        entry: versionMatch,
        reason: "version-only-match",
        variantId: versionMatch.metadata?.variantId,
        version: versionMatch.metadata?.version,
        experimentId: versionMatch.metadata?.experimentId,
      };
    }
    // Fall through — assigned variant doesn't correspond to anything on disk.
  }

  // 2. Control entry (variantId === "control" OR missing variantId) when
  //    multiple entries exist. This picks up the production default.
  const controlEntry = bucket.find(
    (e) => e.metadata?.variantId === "control" || e.metadata?.variantId === undefined,
  );
  if (controlEntry) {
    return {
      entry: controlEntry,
      reason: "control-entry",
      variantId: controlEntry.metadata?.variantId,
      version: controlEntry.metadata?.version,
      experimentId: controlEntry.metadata?.experimentId,
    };
  }

  // 3. Highest semver.
  const sorted = [...bucket].sort((a, b) =>
    compareSemver(b.metadata?.version ?? "0.0.0", a.metadata?.version ?? "0.0.0"),
  );
  const top = sorted[0];
  return {
    entry: top,
    reason: "highest-version",
    variantId: top.metadata?.variantId,
    version: top.metadata?.version,
    experimentId: top.metadata?.experimentId,
  };
}

/**
 * Numeric compare of two semver strings. Treats non-semver as 0.0.0.
 * Returns negative when a < b, positive when a > b. Pre-release and build
 * metadata are stripped for comparison — this is a coarse sort, not a spec
 * implementation.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  if (pa[1] !== pb[1]) return pa[1] - pb[1];
  return pa[2] - pb[2];
}

function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
