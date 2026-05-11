#!/usr/bin/env node
/**
 * Polytropos core release script
 *
 * Constraints encoded:
 * - Release artifact is a byte-for-byte copy of `dist/`.
 * - Tags:
 *   - upstream/<ver>
 *   - polytropos/<ver>+poly.<N>  (N is a global build number)
 * - Determine <ver> from the nearest reachable upstream/<ver> tag.
 * - Release always switches `previous` then `current` (mandatory).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function shInherit(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function getRepoRoot() {
  return sh('git', ['rev-parse', '--show-toplevel']);
}

function getNearestUpstreamTag() {
  // Find the nearest reachable tag matching upstream/*
  const tag = sh('git', ['describe', '--tags', '--match', 'upstream/*', '--abbrev=0']);
  if (!tag.startsWith('upstream/')) fail(`nearest upstream tag did not match expected format: ${tag}`);
  return tag;
}

function parseUpstreamVersion(upstreamTag) {
  return upstreamTag.slice('upstream/'.length);
}

function getMaxPolyBuildNumber() {
  // Scan all polytropos/*+poly.N tags and find max N.
  const out = sh('git', ['tag', '--list', 'polytropos/*+poly.*']);
  if (!out) return -1;
  let max = -1;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/\+poly\.(\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function ensureCleanWorkingTree() {
  const status = sh('git', ['status', '--porcelain']);
  if (status) fail('working tree is not clean; commit or stash changes before releasing');
}

function ensureDistExists(repoRoot) {
  const distDir = path.join(repoRoot, 'dist');
  if (!fs.existsSync(distDir)) fail(`dist/ not found at ${distDir}. Run build first.`);
  const entry = path.join(distDir, 'index.js');
  if (!fs.existsSync(entry)) fail(`dist/index.js not found at ${entry}. Build did not produce runnable dist.`);
  return distDir;
}

function resolveHome() {
  return process.env.HOME || '/home/ec2-user';
}

function releasesRoot() {
  return path.join(resolveHome(), 'polytropos', 'releases');
}

function readlinkAbs(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function lnSfn(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.rmSync(linkPath, { force: true, recursive: true });
  } catch {}
  fs.symlinkSync(target, linkPath);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // Node 22+ has fs.cpSync
  fs.cpSync(src, dest, { recursive: true });
}

function usage() {
  console.log(`polytropos-release.mjs

Usage:
  node scripts/polytropos-release.mjs release

Behavior:
  - Requires clean git working tree
  - Uses nearest reachable upstream/<ver> tag to determine <ver>
  - Computes next global poly build number N = max(existing poly) + 1
  - Creates tag polytropos/<ver>+poly.<N> at HEAD
  - Builds using: pnpm install; pnpm ui:build; pnpm build
  - Copies dist/ -> ~/polytropos/releases/<ver>+poly.<N>/
  - Updates ~/polytropos/releases/previous -> old current (if present)
  - Updates ~/polytropos/releases/current -> new release
  - Restarts gateway: systemctl --user restart openclaw-gateway
`);
}

const cmd = process.argv[2];
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage();
  process.exit(0);
}

if (cmd !== 'release') {
  fail(`unknown command: ${cmd}`);
}

ensureCleanWorkingTree();
const repoRoot = getRepoRoot();
const upstreamTag = getNearestUpstreamTag();
const ver = parseUpstreamVersion(upstreamTag);

const maxPoly = getMaxPolyBuildNumber();
const nextPoly = maxPoly + 1;
const polyTag = `polytropos/${ver}+poly.${nextPoly}`;

console.log(`Upstream base: ${upstreamTag}`);
console.log(`Next release tag: ${polyTag}`);

// Create annotated tag
shInherit('git', ['tag', '-a', polyTag, '-m', `Polytropos release ${polyTag}`]);

// Build dist/
console.log('Building dist/ ...');
shInherit('pnpm', ['install'], { cwd: repoRoot });
shInherit('pnpm', ['ui:build'], { cwd: repoRoot });
shInherit('pnpm', ['build'], { cwd: repoRoot });

const distDir = ensureDistExists(repoRoot);

// Publish into releases
const relRoot = releasesRoot();
const dest = path.join(relRoot, `${ver}+poly.${nextPoly}`);
console.log(`Publishing release: ${dest}`);
fs.mkdirSync(relRoot, { recursive: true });
fs.rmSync(dest, { force: true, recursive: true });
copyDir(distDir, dest);

// Update symlinks: previous then current (mandatory)
const currentLink = path.join(relRoot, 'current');
const previousLink = path.join(relRoot, 'previous');
const currentTarget = readlinkAbs(currentLink);
if (currentTarget) {
  console.log(`Setting previous -> ${currentTarget}`);
  lnSfn(currentTarget, previousLink);
} else {
  console.log('No existing current symlink; setting previous to this release as bootstrap');
  lnSfn(dest, previousLink);
}

console.log(`Setting current -> ${dest}`);
lnSfn(dest, currentLink);

console.log('Restarting gateway...');
shInherit('systemctl', ['--user', 'restart', 'openclaw-gateway']);

console.log('Done.');
console.log(`- Tag: ${polyTag}`);
console.log(`- Release dir: ${dest}`);
console.log(`- current -> ${readlinkAbs(currentLink)}`);
console.log(`- previous -> ${readlinkAbs(previousLink)}`);
