// preview-evi-pool.mjs — show what the EVI pool would look like vs. the
// current worst-F1 pool. Read-only: does not write pool.json.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills } from './lib/skills-io.mjs';
import { readUsage } from './lib/usage.mjs';
import { scoreSkills, selectPool, TARGET_F1, MIN_USAGE } from './lib/pool-selector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..');
const CACHE_DIR = join(__dirname, '.eval-cache');

function loadLatestHaikuCache() {
  if (!existsSync(CACHE_DIR)) throw new Error('No eval cache — run an eval first');
  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('-haiku.json'));
  if (!files.length) throw new Error('No haiku eval cache');
  const sorted = files.map(f => ({ f, mtime: statSync(join(CACHE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return JSON.parse(readFileSync(join(CACHE_DIR, sorted[0].f), 'utf8'));
}

const metrics = loadLatestHaikuCache();
const usage = readUsage();
const skills = listSkills(SKILLS_DIR).filter(s => s !== 'autoresearch');

const scored = scoreSkills({
  perSkillMetrics: metrics.per_skill,
  usageCounts: usage.counts,
  skills,
});

// Current pool = worst-F1 skills (existing logic)
const worstF1Pool = Object.entries(metrics.per_skill)
  .filter(([n]) => skills.includes(n))
  .sort(([, a], [, b]) => a.f1 - b.f1)
  .slice(0, 10)
  .map(([n, m]) => ({ name: n, f1: m.f1, usage: usage.counts[n] || 0 }));

const eviPool = selectPool(scored, 10);

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nEval: global F1 = ${metrics.global_f1.toFixed(3)}  |  Target = ${TARGET_F1}  |  MIN_USAGE = ${MIN_USAGE}`);
console.log(`Usage source: ${usage.source}  generated: ${usage.generated_at || 'n/a'}  window: ${usage.window_days}d`);

console.log('\n=== CURRENT POOL (worst F1, no usage filter) ===');
console.log(`  ${pad('skill', 28)}${pad('F1', 8)}${pad('usage', 8)}`);
for (const s of worstF1Pool) {
  console.log(`  ${pad(s.name, 28)}${pad(s.f1.toFixed(3), 8)}${pad(s.usage, 8)}`);
}

console.log('\n=== PROPOSED POOL (EVI = usage × gap, min 5 uses, F1<0.95) ===');
console.log(`  ${pad('skill', 28)}${pad('F1', 8)}${pad('usage', 8)}${pad('gap', 8)}${pad('EVI', 8)}`);
for (const s of eviPool) {
  console.log(`  ${pad(s.name, 28)}${pad(s.current_f1.toFixed(3), 8)}${pad(s.usage_count, 8)}${pad((TARGET_F1 - s.current_f1).toFixed(3), 8)}${pad(s.evi.toFixed(2), 8)}`);
}

console.log('\n=== OVERLAP ===');
const worstSet = new Set(worstF1Pool.map(s => s.name));
const eviSet = new Set(eviPool.map(s => s.name));
const overlap = [...worstSet].filter(n => eviSet.has(n));
const onlyWorst = [...worstSet].filter(n => !eviSet.has(n));
const onlyEvi = [...eviSet].filter(n => !worstSet.has(n));
console.log(`  in both: ${overlap.length ? overlap.join(', ') : '(none)'}`);
console.log(`  only in worst-F1: ${onlyWorst.length ? onlyWorst.join(', ') : '(none)'}`);
console.log(`  only in EVI: ${onlyEvi.length ? onlyEvi.join(', ') : '(none)'}`);

// Alternate formula: log-dampened to reduce noise from common skill names
const scoredLog = scored
  .filter(s => !s.graduated && !s.below_threshold && s.gap > 0)
  .map(s => ({ ...s, evi_log: Math.log(1 + s.usage_count) * s.gap }))
  .sort((a, b) => b.evi_log - a.evi_log)
  .slice(0, 10);
console.log('\n=== ALT: LOG-DAMPENED EVI = log(1+usage) × gap ===');
console.log(`  ${pad('skill', 28)}${pad('F1', 8)}${pad('usage', 8)}${pad('log(u)', 8)}${pad('EVI_log', 8)}`);
for (const s of scoredLog) {
  console.log(`  ${pad(s.name, 28)}${pad(s.current_f1.toFixed(3), 8)}${pad(s.usage_count, 8)}${pad(Math.log(1+s.usage_count).toFixed(2), 8)}${pad(s.evi_log.toFixed(2), 8)}`);
}

console.log('\n=== DIAGNOSTICS ===');
const skippedLowUse = scored.filter(s => !s.graduated && s.below_threshold).length;
const skippedGraduated = scored.filter(s => s.graduated).length;
const eligible = scored.filter(s => !s.graduated && !s.below_threshold && s.evi > 0).length;
console.log(`  total skills: ${scored.length}`);
console.log(`  eligible (pass filters, EVI>0): ${eligible}`);
console.log(`  skipped — below MIN_USAGE (${MIN_USAGE}): ${skippedLowUse}`);
console.log(`  skipped — already graduated (F1>=${TARGET_F1}): ${skippedGraduated}`);
