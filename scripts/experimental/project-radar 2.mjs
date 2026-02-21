#!/usr/bin/env node
import { readdir, stat, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export function parseArgs(argv) {
  const args = { root: '~/Documents/Code', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--root' && argv[i + 1]) args.root = argv[++i];
  }
  return args;
}

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: out.status === 0, text: (out.stdout || '').trim() };
}

function ageFromMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

async function detectPmHints(repoPath) {
  const hints = [];
  if (await exists(path.join(repoPath, 'package.json'))) hints.push('npm/pnpm/yarn');
  if (await exists(path.join(repoPath, 'Cargo.toml'))) hints.push('cargo');
  if (await exists(path.join(repoPath, 'go.mod'))) hints.push('go');
  return hints;
}

async function collectRepos(root) {
  const repos = [];
  const rootEntries = await readdir(root, { withFileTypes: true });

  async function checkDir(dir) {
    if (await exists(path.join(dir, '.git'))) repos.push(dir);
  }

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    const level1 = path.join(root, entry.name);
    await checkDir(level1);

    const sub = await readdir(level1, { withFileTypes: true }).catch(() => []);
    for (const s of sub) {
      if (!s.isDirectory()) continue;
      await checkDir(path.join(level1, s.name));
    }
  }
  return repos.sort();
}

async function inspectRepo(repoPath) {
  const branch = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).text || 'unknown';
  const dirty = !!runGit(repoPath, ['status', '--porcelain']).text;

  const up = runGit(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let ahead = 0;
  let behind = 0;
  if (up.ok && up.text) {
    const c = runGit(repoPath, ['rev-list', '--left-right', '--count', `${up.text}...HEAD`]).text;
    const [b, a] = c.split(/\s+/).map((n) => Number.parseInt(n, 10));
    behind = Number.isFinite(b) ? b : 0;
    ahead = Number.isFinite(a) ? a : 0;
  }

  const ts = Number.parseInt(runGit(repoPath, ['log', '-1', '--format=%ct']).text, 10) * 1000;
  const age = ageFromMs(Date.now() - ts);

  return {
    name: path.basename(repoPath),
    path: repoPath,
    branch,
    ahead,
    behind,
    dirty,
    lastCommitAge: age,
    pmHints: await detectPmHints(repoPath),
  };
}

function printTable(items) {
  const rows = [
    ['repo', 'branch', 'sync', 'dirty', 'last', 'hints'],
    ...items.map((r) => [
      r.name,
      r.branch,
      `+${r.ahead}/-${r.behind}`,
      r.dirty ? 'yes' : 'no',
      r.lastCommitAge,
      r.pmHints.join(',') || '-',
    ]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const row of rows) {
    console.log(row.map((c, i) => String(c).padEnd(widths[i])).join('  '));
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = expandHome(args.root);
  const repos = await collectRepos(root).catch(() => []);
  const data = [];
  for (const repo of repos) data.push(await inspectRepo(repo));

  if (args.json) {
    console.log(JSON.stringify({ root, count: data.length, repos: data }, null, 2));
    return;
  }
  console.log(`Project Radar: ${root} (${data.length} repos)`);
  printTable(data);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
