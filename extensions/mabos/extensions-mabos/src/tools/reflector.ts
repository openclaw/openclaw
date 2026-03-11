/**
 * Reflector — Garbage collection and compression of the observation log.
 *
 * Removes superseded observations, merges routine entries, and enforces
 * token budgets to keep the observation log compact.
 */

import type { Observation, ObservationPriority } from "./observation-types.js";
import { estimateTokens } from "./observer.js";

// ── Configuration ──

export interface ReflectorConfig {
  observationTokenThreshold: number;
  enabled: boolean;
}

export const DEFAULT_REFLECTOR_CONFIG: ReflectorConfig = {
  observationTokenThreshold: 40000,
  enabled: true,
};

// ── Core Reflector ──

export function reflectObservations(
  observations: Observation[],
  config?: Partial<ReflectorConfig>,
): Observation[] {
  const threshold =
    config?.observationTokenThreshold ?? DEFAULT_REFLECTOR_CONFIG.observationTokenThreshold;
  let result = [...observations];

  // Step 1: Remove already-superseded observations
  result = result.filter((obs) => !obs.superseded_by);

  // Step 2: Mark superseded observations (same tags + newer observation exists)
  result = markSuperseded(result);
  result = result.filter((obs) => !obs.superseded_by);

  // Step 3: Drop routine observations older than 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  result = result.filter((obs) => obs.priority !== "routine" || obs.created_at >= sevenDaysAgo);

  // Step 4: Merge routine observations from same date into summaries
  result = mergeRoutineByDate(result);

  // Step 5: If still over token budget, remove oldest routine entries first
  while (estimateLogTokens(result) > threshold && hasRemovableRoutine(result)) {
    // Find and remove the oldest routine observation
    let oldestIdx = -1;
    let oldestDate = "";
    for (let i = 0; i < result.length; i++) {
      if (result[i].priority === "routine") {
        if (oldestIdx === -1 || result[i].created_at < oldestDate) {
          oldestIdx = i;
          oldestDate = result[i].created_at;
        }
      }
    }
    if (oldestIdx >= 0) {
      result.splice(oldestIdx, 1);
    } else {
      break;
    }
  }

  return result;
}

// ── Helpers ──

function markSuperseded(observations: Observation[]): Observation[] {
  // Group by significant tags (file: and tool: tags)
  const tagGroups = new Map<string, Observation[]>();

  for (const obs of observations) {
    for (const tag of obs.tags) {
      if (tag.startsWith("file:") || tag.startsWith("tool:")) {
        if (!tagGroups.has(tag)) tagGroups.set(tag, []);
        tagGroups.get(tag)!.push(obs);
      }
    }
  }

  // Within each tag group, newer observations supersede older ones with same priority
  for (const group of Array.from(tagGroups.values())) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.created_at.localeCompare(b.created_at));

    for (let i = 0; i < group.length - 1; i++) {
      const older = group[i];
      const newer = group[i + 1];
      // Only supersede if same priority level and both routine/important
      if (older.priority === newer.priority && older.priority !== "critical") {
        older.superseded_by = newer.id;
      }
    }
  }

  return observations;
}

function mergeRoutineByDate(observations: Observation[]): Observation[] {
  const routineByDate = new Map<string, Observation[]>();
  const nonRoutine: Observation[] = [];

  for (const obs of observations) {
    if (obs.priority === "routine") {
      const date = obs.observed_at.split("T")[0] || "unknown";
      if (!routineByDate.has(date)) routineByDate.set(date, []);
      routineByDate.get(date)!.push(obs);
    } else {
      nonRoutine.push(obs);
    }
  }

  const merged: Observation[] = [...nonRoutine];

  for (const [date, routines] of Array.from(routineByDate.entries())) {
    if (routines.length <= 3) {
      // Few enough to keep individually
      merged.push(...routines);
    } else {
      // Merge into a summary observation
      const summaryContent = routines.map((r) => r.content.split("\n")[0].slice(0, 100)).join("; ");
      const allTags = new Set<string>();
      for (const r of routines) r.tags.forEach((t) => allTags.add(t));
      const allRefDates = new Set<string>();
      for (const r of routines) r.referenced_dates?.forEach((d) => allRefDates.add(d));

      merged.push({
        id: routines[0].id, // Reuse first ID for stability
        priority: "routine",
        content: `[${routines.length} routine items] ${summaryContent}`,
        observed_at: routines[0].observed_at,
        referenced_dates: allRefDates.size > 0 ? Array.from(allRefDates).sort() : undefined,
        tags: Array.from(allTags).slice(0, 10),
        created_at: routines[0].created_at,
      });
    }
  }

  // Sort by created_at for deterministic output
  merged.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return merged;
}

function estimateLogTokens(observations: Observation[]): number {
  let chars = 0;
  for (const obs of observations) {
    chars += obs.content.length + 50; // 50 chars overhead for metadata
  }
  return estimateTokens(String.fromCharCode(0).repeat(chars)); // chars / 4
}

function hasRemovableRoutine(observations: Observation[]): boolean {
  return observations.some((o) => o.priority === "routine");
}
