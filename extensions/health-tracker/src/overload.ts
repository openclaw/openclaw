import type { LoggedSet, PlateauInfo, SetTarget } from "./workout-types.js";

const WEIGHT_INCREMENT = 2.5;

/** Parse a rep range string like "6-8" into [min, max]. Fallback: [6, 12]. */
export function parseRange(rr: string): [number, number] {
  const parts = rr.split("-").map(Number);
  if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
    return [parts[0]!, parts[1]!];
  }
  return [6, 12];
}

/**
 * True if all required sets hit the top of their rep range.
 * Each set is checked against the corresponding rep range (cycling if fewer ranges than sets).
 */
export function allSetsHitTop(
  lastSets: { reps: number }[],
  repRanges: string[],
  requiredSets: number,
): boolean {
  if (lastSets.length < requiredSets || repRanges.length === 0) return false;
  for (let i = 0; i < requiredSets; i++) {
    const range = repRanges[i % repRanges.length]!;
    const [, top] = parseRange(range);
    if (lastSets[i]!.reps < top) return false;
  }
  return true;
}

/**
 * Build per-set targets based on last performance.
 * If all sets hit top of range, bump weight by 2.5kg and reset to bottom of range.
 */
export function buildSetTargets(
  lastSets: { weight: number; reps: number }[],
  repRanges: string[],
  setCount: number,
): SetTarget[] {
  if (repRanges.length === 0) return [];

  const shouldBump = lastSets.length >= setCount && allSetsHitTop(lastSets, repRanges, setCount);
  const targets: SetTarget[] = [];

  for (let i = 0; i < setCount; i++) {
    const range = repRanges[i % repRanges.length]!;
    const [repMin, repMax] = parseRange(range);
    const lastSet = lastSets[i];
    const baseWeight = lastSet ? lastSet.weight : 0;
    const weight = shouldBump ? baseWeight + WEIGHT_INCREMENT : baseWeight;

    targets.push({
      setNumber: i + 1,
      weight,
      repMin,
      repMax,
      repGoal: shouldBump ? `${repMin}-${repMax}` : range,
    });
  }

  return targets;
}

/** Human-readable progressive overload suggestion. */
export function overloadSuggestion(
  lastSets: { weight: number; reps: number; note?: string }[],
  repRanges: string[],
  plannedSets: number,
): string {
  if (lastSets.length === 0 || repRanges.length === 0) {
    return "No previous data. Start with a comfortable weight.";
  }

  if (allSetsHitTop(lastSets, repRanges, plannedSets)) {
    const topWeight = Math.max(...lastSets.slice(0, plannedSets).map((s) => s.weight));
    const newWeight = topWeight + WEIGHT_INCREMENT;
    return `All ${plannedSets} sets hit top of range! Bump to ${newWeight}kg.`;
  }

  const range = repRanges[0]!;
  const [, top] = parseRange(range);
  const missingSets = lastSets.slice(0, plannedSets).filter((s, i) => {
    const r = repRanges[i % repRanges.length]!;
    const [, t] = parseRange(r);
    return s.reps < t;
  });

  if (missingSets.length > 0) {
    const topWeight = lastSets[0]?.weight ?? 0;
    return `Keep ${topWeight}kg and push for more reps (target top of range).`;
  }

  return "Keep current weight and aim for top of rep range on all sets.";
}

/** Target weight for set 1 of the next session. */
export function getSuggestedWeight(
  lastSets: { weight: number; reps: number }[],
  repRanges: string[],
  plannedSets: number,
): number {
  if (lastSets.length === 0) return 0;

  const topWeight = Math.max(...lastSets.slice(0, plannedSets).map((s) => s.weight));
  if (allSetsHitTop(lastSets, repRanges, plannedSets)) {
    return topWeight + WEIGHT_INCREMENT;
  }
  return topWeight;
}

/**
 * Check last 3 sessions for a plateau (no improvement in weight OR reps).
 * Returns null if fewer than 3 sessions or if progress is being made.
 */
export function checkPlateau(
  history: { date: string; sets: { weight: number; reps: number }[] }[],
): PlateauInfo | null {
  if (history.length < 3) return null;

  const recent = history.slice(0, 3);

  // Get top weight and top reps from each session
  const topWeights = recent.map((h) => Math.max(...h.sets.map((s) => s.weight)));
  const topReps = recent.map((h) => Math.max(...h.sets.map((s) => s.reps)));

  // Plateau: no improvement in either top weight or top reps across all 3 sessions
  const weightImproved = topWeights[0]! > topWeights[1]! || topWeights[0]! > topWeights[2]!;
  const repsImproved = topReps[0]! > topReps[1]! || topReps[0]! > topReps[2]!;

  if (weightImproved || repsImproved) return null;

  return {
    stuckFor: 3,
    lastWeight: topWeights[0]!,
    suggestion:
      "Plateau detected over 3 sessions. Consider a deload week, " +
      "variation swap, or micro-loading (+1.25kg).",
  };
}

/**
 * Estimate rest time in seconds based on training style and rep ranges.
 * RPT (reverse pyramid) gets longest rest; higher rep ranges get shorter rest.
 */
export function estimateRestSeconds(style: string | undefined, repRanges: string[]): number {
  if (style?.toLowerCase() === "rpt") return 180;

  if (repRanges.length === 0) return 120;

  const [repMin] = parseRange(repRanges[0]!);
  if (repMin <= 5) return 150;
  if (repMin <= 8) return 120;
  return 90;
}
