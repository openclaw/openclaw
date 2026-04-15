// pool-selector.mjs — EVI (Expected Value of Improvement) scoring
//
//   EVI = min(usage_count, USAGE_CAP) * (target_f1 - current_f1)
//
// USAGE_CAP prevents a single outlier (inflated by substring-match noise)
// from dominating the ranking.
// Skills with usage_count < MIN_USAGE are excluded (low signal).
// Skills with current_f1 >= target_f1 are excluded (graduated).

export const TARGET_F1 = 0.95;
export const MIN_USAGE = 5;
export const USAGE_CAP = 5000;

export function scoreSkills({ perSkillMetrics, usageCounts, skills, targetF1 = TARGET_F1, minUsage = MIN_USAGE, usageCap = USAGE_CAP }) {
  const scored = [];
  for (const name of skills) {
    const m = perSkillMetrics[name];
    const f1 = m?.f1 ?? 0;
    const count = usageCounts[name] || 0;
    const clipped = Math.min(count, usageCap);
    const gap = Math.max(0, targetF1 - f1);
    const evi = clipped * gap;
    scored.push({
      name,
      usage_count: count,
      usage_clipped: clipped,
      current_f1: f1,
      gap,
      evi,
      graduated: f1 >= targetF1,
      below_threshold: count < minUsage,
    });
  }
  return scored;
}

export function selectPool(scored, size = 10) {
  return scored
    .filter(s => !s.graduated && !s.below_threshold && s.evi > 0)
    .sort((a, b) => b.evi - a.evi)
    .slice(0, size)
    .map(s => ({
      name: s.name,
      baseline_f1: s.current_f1,
      current_f1: s.current_f1,
      usage_count: s.usage_count,
      evi: s.evi,
      exhausted: false,
      graduated: false,
    }));
}
