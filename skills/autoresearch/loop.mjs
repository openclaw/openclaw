// loop.mjs — main experiment runner
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createGitOps } from './lib/git-ops.mjs';
import { createBudgetTracker } from './lib/budget.mjs';
import { checkLength, checkStuffing, checkDrift } from './lib/tripwires.mjs';
import { readSkillDescription, writeSkillDescription } from './lib/skills-io.mjs';
import { proposeEdit } from './lib/anthropic-client.mjs';
import { runEval } from './evaluate.mjs';
import { buildMarkdownReport, renderMarkdownToPdf } from './report-generator.mjs';
import { startApprovalServer } from './approval-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..');
const REPO_DIR = join(__dirname, '..', '..');
const USER_STATE = join(homedir(), '.autoresearch');
const STOP_FILE = join(USER_STATE, 'STOP');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function checkPreconditions(opts = {}) {
  if (existsSync(STOP_FILE)) throw new Error('STOP file present — loop disabled');
  mkdirSync(USER_STATE, { recursive: true });
  const ranFlag = join(USER_STATE, `.ran-${todayStr()}`);
  if (existsSync(ranFlag) && !opts.force) throw new Error('Already ran today');
  if (!opts.force) {
    const now = new Date();
    const hh = now.getHours() + now.getMinutes() / 60;
    if (hh >= 12.0) throw new Error('Past morning window (after 12:00)');
    if (hh < 10.5) {
      const waitMs = Math.round((10.5 - hh) * 3600 * 1000);
      console.log(`Before window — sleeping ${Math.round(waitMs / 60000)}m until 10:30`);
      return { ranFlag, waitMs };
    }
  }
  return { ranFlag, waitMs: 0 };
}

async function proposeAndValidate({ skill, currentDesc, misroutes, model, apiKey }) {
  const { newDescription, inputTokens, outputTokens } = await proposeEdit({ skill, currentDesc, misroutes, model, apiKey });
  const lenCheck = checkLength(newDescription);
  if (!lenCheck.ok) return { valid: false, reason: lenCheck.reason, inputTokens, outputTokens };
  const stuffCheck = checkStuffing(newDescription);
  if (!stuffCheck.ok) return { valid: false, reason: stuffCheck.reason, inputTokens, outputTokens };
  const driftCheck = checkDrift(currentDesc, newDescription);
  if (!driftCheck.ok) return { valid: false, reason: 'drift', similarity: driftCheck.similarity, inputTokens, outputTokens };
  return { valid: true, newDescription, inputTokens, outputTokens };
}

async function runExperiment({ skill, model, apiKey, git, baselineEval, budget, experimentNum, jsonlPath }) {
  const currentDesc = readSkillDescription(SKILLS_DIR, skill);
  const misroutes = baselineEval.misroutes.filter(m => m.expected === skill).slice(0, 5);
  const old_f1 = baselineEval.per_skill[skill]?.f1 ?? 0;

  const proposal = await proposeAndValidate({ skill, currentDesc, misroutes, model, apiKey });
  if (budget) budget.record({ inputTokens: proposal.inputTokens, outputTokens: proposal.outputTokens });
  if (!proposal.valid) {
    appendFileSync(jsonlPath, JSON.stringify({ exp: experimentNum, skill, model, outcome: 'rejected', reason: proposal.reason }) + '\n');
    return { outcome: 'rejected', stallIncrement: 0 };
  }

  writeSkillDescription(SKILLS_DIR, skill, proposal.newDescription);
  const newEval = await runEval({ model: 'haiku', apiKey });
  const new_f1 = newEval.per_skill[skill]?.f1 ?? 0;
  const delta = new_f1 - old_f1;

  if (delta > 0) {
    await git.commitWin(`autoresearch: ${skill} +${delta.toFixed(3)}`);
    appendFileSync(jsonlPath, JSON.stringify({ exp: experimentNum, skill, model, old_f1, new_f1, delta, outcome: 'commit', cost_usd: budget?.spent() ?? 0 }) + '\n');
    return { outcome: 'commit', delta, stallIncrement: 0, newBaseline: newEval };
  } else {
    await git.resetHard();
    appendFileSync(jsonlPath, JSON.stringify({ exp: experimentNum, skill, model, old_f1, new_f1, delta, outcome: 'reset', cost_usd: budget?.spent() ?? 0 }) + '\n');
    return { outcome: 'reset', delta, stallIncrement: 1 };
  }
}

async function runPhase({ name, experiments, models, pool, apiKey, baselineEval, git, budget, jsonlPath, phaseStartExp }) {
  let baseline = baselineEval;
  let expNum = phaseStartExp;
  const stalls = Object.fromEntries(pool.map(p => [p.name, 0]));
  let i = 0;
  while (i < experiments && pool.some(p => !p.exhausted)) {
    const remaining = pool.filter(p => !p.exhausted);
    if (!remaining.length) break;
    const skill = remaining[i % remaining.length].name;
    const model = models[i % models.length];
    if (budget && !budget.canAfford(0.20)) break;
    const res = await runExperiment({ skill, model, apiKey, git, baselineEval: baseline, budget, experimentNum: ++expNum, jsonlPath });
    if (res.newBaseline) baseline = res.newBaseline;
    if (res.stallIncrement) {
      stalls[skill]++;
      if (stalls[skill] >= 7) pool.find(p => p.name === skill).exhausted = true;
    } else if (res.outcome === 'commit') {
      stalls[skill] = 0;
    }
    i++;
  }
  return { lastBaseline: baseline, lastExpNum: expNum };
}

export async function main({ force = false, dryRun = false } = {}) {
  const { ranFlag, waitMs } = checkPreconditions({ force });
  if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  const apiKey = process.env.ANTHROPIC_API_KEY || readAnthropicKeyFromEnvFile();
  const git = createGitOps(REPO_DIR);
  if (await git.hasUncommittedChanges()) throw new Error('Repo has uncommitted changes');
  const date = todayStr();
  const branch = await git.createAutoBranch(date);
  const reportsDir = join(__dirname, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const jsonlPath = join(reportsDir, `${date}-experiments.jsonl`);
  writeFileSync(jsonlPath, '');

  const pool = JSON.parse(readFileSync(join(__dirname, 'pool.json'), 'utf8')).skills.filter(s => !s.graduated);
  const baselineEval = await runEval({ model: 'haiku', apiKey });

  if (dryRun) {
    console.log('Dry run — baseline:', baselineEval.global_f1);
    console.log('Pool:', pool.map(p => p.name));
    return;
  }

  const phase1 = await runPhase({
    name: 'Phase 1', experiments: 20, models: [...Array(15).fill('opus'), ...Array(5).fill('sonnet')],
    pool, apiKey, baselineEval, git, budget: null, jsonlPath, phaseStartExp: 0,
  });

  const budget = createBudgetTracker(4.00);
  const phase2 = await runPhase({
    name: 'Phase 2', experiments: 100, models: ['sonnet'],
    pool, apiKey, baselineEval: phase1.lastBaseline, git, budget, jsonlPath, phaseStartExp: phase1.lastExpNum,
  });

  const updatedPool = await updatePoolWithGraduations(pool, phase2.lastBaseline, apiKey);
  writeFileSync(join(__dirname, 'pool.json'), JSON.stringify({ skills: updatedPool, last_updated: new Date().toISOString() }, null, 2));

  const experiments = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const token = crypto.randomBytes(8).toString('hex');
  const md = buildMarkdownReport({ date, experiments, token, totalCost: budget.spent(), flags: [] });
  const mdPath = join(reportsDir, `${date}-report.md`);
  const pdfPath = join(reportsDir, `${date}-report.pdf`);
  writeFileSync(mdPath, md);
  renderMarkdownToPdf(mdPath, pdfPath);

  startApprovalServer({ branch, date, token, repoDir: REPO_DIR });
  execSync(`start "" "${pdfPath}"`, { shell: true });

  writeFileSync(ranFlag, new Date().toISOString());
  console.log(`Autoresearch ${date} complete. Commits: ${experiments.filter(e => e.outcome === 'commit').length}. $ spent: ${budget.spent().toFixed(2)}`);
}

async function updatePoolWithGraduations(pool, latestEval, apiKey) {
  return pool.map(p => {
    const m = latestEval.per_skill[p.name];
    const reached = m && m.precision >= 0.95 && m.recall >= 0.95;
    return { ...p, current_f1: m?.f1 ?? p.current_f1, graduated: reached };
  });
}

function readAnthropicKeyFromEnvFile() {
  const envPath = join(homedir(), '.openclaw', '.env');
  if (!existsSync(envPath)) throw new Error('ANTHROPIC_API_KEY not set and ~/.openclaw/.env missing');
  const line = readFileSync(envPath, 'utf8').split('\n').find(l => l.startsWith('ANTHROPIC_API_KEY='));
  if (!line) throw new Error('ANTHROPIC_API_KEY not in ~/.openclaw/.env');
  return line.split('=')[1].trim();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  main({ force: args.includes('--force'), dryRun: args.includes('--dry-run') })
    .catch(e => { console.error(e); process.exit(1); });
}
