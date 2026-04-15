// evaluate.mjs (partial — Task 7 adds runEval main)
import { createHash } from 'node:crypto';

export function computeMetrics(results) {
  const byExpected = {};
  const byPredicted = {};
  const allSkills = new Set();
  for (const r of results) {
    allSkills.add(r.expected);
    allSkills.add(r.predicted);
    byExpected[r.expected] = byExpected[r.expected] || { total: 0, correct: 0 };
    byPredicted[r.predicted] = byPredicted[r.predicted] || { total: 0 };
    byExpected[r.expected].total++;
    byPredicted[r.predicted].total++;
    if (r.expected === r.predicted) byExpected[r.expected].correct++;
  }
  const per_skill = {};
  let f1Sum = 0, f1Count = 0;
  for (const skill of allSkills) {
    const tp = byExpected[skill]?.correct || 0;
    const fn = (byExpected[skill]?.total || 0) - tp;
    const fp = (byPredicted[skill]?.total || 0) - tp;
    const precision = (tp + fp) ? tp / (tp + fp) : 0;
    const recall = (tp + fn) ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0;
    per_skill[skill] = { precision, recall, f1, tp, fp, fn };
    f1Sum += f1; f1Count++;
  }
  return { per_skill, global_f1: f1Count ? f1Sum / f1Count : 0 };
}

export function cacheKeyFromSkills(skills) {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const joined = sorted.map(s => `${s.name}::${s.description}`).join('\n');
  return createHash('sha256').update(joined).digest('hex');
}
