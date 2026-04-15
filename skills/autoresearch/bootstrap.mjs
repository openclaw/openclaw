// bootstrap.mjs — run once, generates eval-set.json + pool.json
// Usage: ANTHROPIC_API_KEY=... node bootstrap.mjs
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { completeOnce } from './lib/anthropic-client.mjs';
import { listSkills, readSkillDescription } from './lib/skills-io.mjs';
import { runEval } from './evaluate.mjs';
import { readUsage } from './lib/usage.mjs';
import { scoreSkills, selectPool } from './lib/pool-selector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..');
const FLAG = join(homedir(), '.autoresearch', 'bootstrap-complete.flag');

async function generateEvalPairs(skillName, description, apiKey) {
  const prompt = `Generate 20 short user messages for testing skill routing. Skill: "${skillName}". Description: "${description}".

- First 10: POSITIVE examples — messages that SHOULD route to this skill.
- Last 10: NEGATIVE adversarial near-misses — messages that sound similar but should NOT route to this skill.

Output ONLY a JSON array of 20 objects: [{"message": "...", "should_route": true|false}, ...]`;
  const { text } = await completeOnce({ prompt, model: 'opus', maxTokens: 1500, apiKey });
  const raw = text.match(/\[[\s\S]*\]/)?.[0];
  if (!raw) throw new Error(`Bad JSON from Opus for ${skillName}`);
  return JSON.parse(raw);
}

async function main() {
  if (existsSync(FLAG)) { console.log('Bootstrap already complete'); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required');

  const skills = listSkills(SKILLS_DIR).filter(s => s !== 'autoresearch');
  const evalSetPath = join(__dirname, 'eval-set.json');
  if (existsSync(evalSetPath)) {
    console.log(`Reusing existing eval-set.json (${JSON.parse(readFileSync(evalSetPath, 'utf8')).length} pairs)`);
  } else {
  console.log(`Generating eval pairs for ${skills.length} skills...`);

  const allPairs = [];
  for (const skill of skills) {
    process.stdout.write(`  ${skill}... `);
    try {
      const desc = readSkillDescription(SKILLS_DIR, skill);
      const pairs = await generateEvalPairs(skill, desc, apiKey);
      for (const p of pairs) {
        allPairs.push({
          user_message: p.message,
          correct_skill: p.should_route ? skill : 'none',
        });
      }
      console.log('ok');
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  writeFileSync(evalSetPath, JSON.stringify(allPairs, null, 2));
  console.log(`Wrote ${allPairs.length} pairs to eval-set.json`);
  }

  console.log('Running baseline eval...');
  const metrics = await runEval({ model: 'haiku', apiKey });
  const usage = readUsage();
  if (usage.source === 'missing') {
    console.warn('Warning: ~/.autoresearch/usage.json missing — run bootstrap-usage.mjs first. Falling back to worst-F1 pool.');
    const ranked = Object.entries(metrics.per_skill)
      .filter(([name]) => name !== 'none' && skills.includes(name))
      .sort(([, a], [, b]) => a.f1 - b.f1);
    var pool = {
      selection_method: 'worst_f1_fallback',
      skills: ranked.slice(0, 10).map(([name, m]) => ({
        name, baseline_f1: m.f1, current_f1: m.f1, exhausted: false, graduated: false,
      })),
      last_updated: new Date().toISOString(),
    };
  } else {
    const scored = scoreSkills({ perSkillMetrics: metrics.per_skill, usageCounts: usage.counts, skills });
    var pool = {
      selection_method: 'evi_linear_capped',
      usage_window_days: usage.window_days,
      usage_generated_at: usage.generated_at,
      skills: selectPool(scored, 10),
      last_updated: new Date().toISOString(),
    };
  }
  writeFileSync(join(__dirname, 'pool.json'), JSON.stringify(pool, null, 2));
  console.log(`Pool (${pool.selection_method}): ${pool.skills.map(s => s.name).join(', ')}`);

  mkdirSync(dirname(FLAG), { recursive: true });
  writeFileSync(FLAG, new Date().toISOString());
  console.log('Bootstrap complete.');
}

main().catch(e => { console.error(e); process.exit(1); });
