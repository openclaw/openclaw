import type { UsageEntry } from "./telemetry.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TransitionThresholds {
  stale_after_days: number;
  archive_after_days: number;
}

export type TransitionAction = "none" | "mark_stale" | "archive";

export interface TransitionResult {
  newState: UsageEntry["state"];
  action: TransitionAction;
  daysSinceUsed: number;
}

// ── Logic ───────────────────────────────────────────────────────────────────

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Determine what transition (if any) should be applied to a skill entry
 * based on its last_used_at timestamp and the configured thresholds.
 *
 * Rules:
 * - Pinned skills are never transitioned.
 * - Already-archived skills stay archived.
 * - If days since last use > archive_after_days → archive.
 * - If days since last use > stale_after_days → mark stale.
 * - Otherwise → no change.
 */
export function determineTransition(
  entry: UsageEntry,
  thresholds: TransitionThresholds,
  now: Date = new Date(),
): TransitionResult {
  const daysSinceUsed = daysSinceLastUse(entry, now);

  // Pinned skills are immune
  if (entry.pinned) {
    return { newState: entry.state, action: "none", daysSinceUsed };
  }

  // Already archived stays archived
  if (entry.state === "archived") {
    return { newState: "archived", action: "none", daysSinceUsed };
  }

  // Archive threshold
  if (daysSinceUsed > thresholds.archive_after_days) {
    return { newState: "archived", action: "archive", daysSinceUsed };
  }

  // Stale threshold
  if (daysSinceUsed > thresholds.stale_after_days) {
    return { newState: "stale", action: "mark_stale", daysSinceUsed };
  }

  // No transition needed
  return { newState: entry.state, action: "none", daysSinceUsed };
}

/**
 * Calculate days since the skill was last used.
 * Falls back to created_at if last_used_at is null.
 */
export function daysSinceLastUse(entry: UsageEntry, now: Date = new Date()): number {
  const reference = entry.last_used_at ?? entry.created_at;
  const refDate = new Date(reference);
  return (now.getTime() - refDate.getTime()) / MS_PER_DAY;
}

/**
 * Determine transitions for all entries in a usage file.
 * Returns only entries that require action (non-"none").
 */
export function determineAllTransitions(
  skills: Record<string, UsageEntry>,
  thresholds: TransitionThresholds,
  now: Date = new Date(),
): Array<{ name: string; result: TransitionResult }> {
  const results: Array<{ name: string; result: TransitionResult }> = [];
  for (const [name, entry] of Object.entries(skills)) {
    // Skip bundled and hub-installed skills
    if (entry.source === "bundled" || entry.source === "hub") {
      continue;
    }
    const result = determineTransition(entry, thresholds, now);
    if (result.action !== "none") {
      results.push({ name, result });
    }
  }
  return results;
}
