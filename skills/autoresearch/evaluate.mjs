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

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeSkill } from './lib/anthropic-client.mjs';
import { listSkills, readSkillDescription } from './lib/skills-io.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..');  // skills/autoresearch/ → skills/
const CACHE_DIR = join(__dirname, '.eval-cache');

function loadEvalSet() {
  return JSON.parse(readFileSync(join(__dirname, 'eval-set.json'), 'utf8'));
}

function loadSkillsSnapshot() {
  const names = listSkills(SKILLS_DIR);
  const out = [];
  for (const name of names) {
    try {
      out.push({ name, description: readSkillDescription(SKILLS_DIR, name) });
    } catch {
      // Skip skills with missing/malformed frontmatter — they can't participate in routing.
    }
  }
  return out;
}

async function runConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    const i = cursor++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    return next();
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return results;
}

export async function runEval({ model = 'haiku', apiKey, useCache = true } = {}) {
  const evalSet = loadEvalSet();
  const skills = loadSkillsSnapshot();
  const cacheKey = cacheKeyFromSkills(skills) + `-${model}`;
  const cachePath = join(CACHE_DIR, `${cacheKey}.json`);

  if (useCache && existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }

  const start = Date.now();
  let totalIn = 0, totalOut = 0;
  const results = await runConcurrent(evalSet, 20, async (pair) => {
    const { predicted, inputTokens, outputTokens } = await routeSkill({
      message: pair.user_message,
      skillsList: skills,
      model,
      apiKey,
    });
    totalIn += inputTokens; totalOut += outputTokens;
    return { expected: pair.correct_skill, predicted, message: pair.user_message };
  });

  const metrics = computeMetrics(results);
  const output = {
    ...metrics,
    duration_ms: Date.now() - start,
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    misroutes: results.filter(r => r.expected !== r.predicted),
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(output));
  return output;
}

// CLI entry: node evaluate.mjs → prints JSON
if (process.argv[1]) {
  const normalized = process.argv[1].replace(/\\/g, '/');
  const isMainModule = import.meta.url === `file:///${normalized}` ||
                       import.meta.url.replace(/\//g, '\\') === `file:///${process.argv[1]}`;
  if (isMainModule) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }
    const model = process.argv.includes('--opus') ? 'opus' : 'haiku';
    runEval({ model, apiKey }).then(r => {
      console.log(JSON.stringify(r));
    }).catch(e => { console.error(e); process.exit(1); });
  }
}
