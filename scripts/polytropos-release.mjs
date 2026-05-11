#!/usr/bin/env node
/**
 * Polytropos core release script
 *
 * Constraints encoded:
 * - Release artifact is an npm pack tarball (`.tgz`) produced by `npm pack`.
 * - Tags:
 *   - upstream tag: v<ver> (fetched from upstream remote)
 *   - polytropos tag: v<ver>+poly.<N>  (N is a global build number)
 * - Determine v<ver> from the most recent reachable upstream tag (v*).
 * - Release always switches `previous.tgz` then `current.tgz` (mandatory), installs `current.tgz` globally, then restarts the gateway.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function shInherit(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function getRepoRoot() {
  return sh("git", ["rev-parse", "--show-toplevel"]);
}

function getMostRecentReachableUpstreamVTag() {
  // Use nearest reachable tag that looks like an upstream release tag (v2026.5.10 etc).
  // We intentionally ignore poly tags here.
  let tag = "";
  try {
    tag = sh("git", ["describe", "--tags", "--match", "v*", "--abbrev=0"]);
  } catch {
    fail(
      "no reachable upstream v* tag found from HEAD; fetch upstream tags and ensure history includes a v<ver> tag",
    );
  }
  if (tag.includes("+poly.")) {
    // If git picked a poly tag, explicitly fail; the base version must come from an upstream v* tag.
    fail(
      `nearest reachable v* tag was a poly tag (${tag}); expected an upstream tag like v2026.5.10`,
    );
  }
  return tag;
}

function getMaxPolyBuildNumber() {
  // Scan all polytropos/*+poly.N tags and find max N.
  const out = sh("git", ["tag", "--list", "v*+poly.*"]);
  if (!out) {
    return -1;
  }
  let max = -1;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/\+poly\.(\d+)$/);
    if (!m) {
      continue;
    }
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) {
      max = n;
    }
  }
  return max;
}

function ensureCleanWorkingTree() {
  const status = sh("git", ["status", "--porcelain"]);
  if (status) {
    fail("working tree is not clean; commit or stash changes before releasing");
  }
}

function ensureDistExists(repoRoot) {
  const distDir = path.join(repoRoot, "dist");
  if (!fs.existsSync(distDir)) {
    fail(`dist/ not found at ${distDir}. Run build first.`);
  }
  const entry = path.join(distDir, "index.js");
  if (!fs.existsSync(entry)) {
    fail(`dist/index.js not found at ${entry}. Build did not produce runnable dist.`);
  }
  return distDir;
}

function getGlobalPrefix() {
  // This host uses ~/.npm-global; keep it explicit so installs land where systemd expects.
  return "/home/ec2-user/.npm-global";
}

function npmPack(repoRoot, outDir, tarballName) {
  fs.mkdirSync(outDir, { recursive: true });
  // npm pack writes the tarball filename to stdout.
  const packed = sh("npm", ["pack", "--silent", "--pack-destination", outDir], { cwd: repoRoot });
  const produced = path.join(outDir, packed);
  if (!fs.existsSync(produced)) {
    fail(`npm pack reported ${packed} but file not found at ${produced}`);
  }

  const target = path.join(outDir, tarballName);
  fs.rmSync(target, { force: true });
  fs.renameSync(produced, target);
  return target;
}

function resolveHome() {
  return process.env.HOME || "/home/ec2-user";
}

function releasesRoot() {
  return path.join(resolveHome(), "polytropos", "releases");
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

function usage() {
  console.log(`polytropos-release.mjs

Usage:
  node scripts/polytropos-release.mjs release

Behavior:
  - Requires clean git working tree
  - Uses the most recent reachable upstream tag (v<ver>) as the base
  - Computes next global poly build number N = max(existing poly) + 1
  - Creates tag v<ver>+poly.<N> at HEAD
  - Builds using: pnpm install; pnpm ui:build; pnpm build
  - Produces tarball via npm pack: ~/polytropos/releases/v<ver>+poly.<N>.tgz
  - Updates ~/polytropos/releases/previous.tgz -> old current.tgz (if present)
  - Updates ~/polytropos/releases/current.tgz -> new tarball
  - Installs current.tgz globally into /home/ec2-user/.npm-global
  - Restarts gateway: systemctl --user restart openclaw-gateway
`);
}

const cmd = process.argv[2];
if (!cmd || cmd === "--help" || cmd === "-h") {
  usage();
  process.exit(0);
}

if (cmd !== "release") {
  fail(`unknown command: ${cmd}`);
}

ensureCleanWorkingTree();
const repoRoot = getRepoRoot();
const upstreamVTag = getMostRecentReachableUpstreamVTag();

const maxPoly = getMaxPolyBuildNumber();
const nextPoly = maxPoly + 1;
const polyTag = `${upstreamVTag}+poly.${nextPoly}`;

console.log(`Upstream base tag (nearest reachable): ${upstreamVTag}`);
console.log(`Next release tag: ${polyTag}`);

// Create annotated tag
shInherit("git", ["tag", "-a", polyTag, "-m", `Polytropos release ${polyTag}`]);

// Build dist/
console.log("Building dist/ ...");
shInherit("pnpm", ["install"], { cwd: repoRoot });
shInherit("pnpm", ["ui:build"], { cwd: repoRoot });
shInherit("pnpm", ["build"], { cwd: repoRoot });

ensureDistExists(repoRoot);

// Produce tarball into releases
const relRoot = releasesRoot();
fs.mkdirSync(relRoot, { recursive: true });
const tarName = `${polyTag}.tgz`;
const tarPath = npmPack(repoRoot, relRoot, tarName);
console.log(`Packed tarball: ${tarPath}`);

// Update symlinks: previous.tgz then current.tgz (mandatory)
const currentTgz = path.join(relRoot, "current.tgz");
const previousTgz = path.join(relRoot, "previous.tgz");
const currentTarget = readlinkAbs(currentTgz);
if (currentTarget) {
  console.log(`Setting previous.tgz -> ${currentTarget}`);
  lnSfn(currentTarget, previousTgz);
} else {
  console.log("No existing current.tgz symlink; setting previous.tgz to this tarball as bootstrap");
  lnSfn(tarPath, previousTgz);
}

console.log(`Setting current.tgz -> ${tarPath}`);
lnSfn(tarPath, currentTgz);

// Install tarball globally into the prefix used by systemd
const prefix = getGlobalPrefix();
console.log(`Installing globally into prefix: ${prefix}`);
shInherit("npm", ["install", "-g", "--prefix", prefix, currentTgz]);

console.log("Restarting gateway...");
shInherit("systemctl", ["--user", "restart", "openclaw-gateway"]);

console.log("Done.");
console.log(`- Tag: ${polyTag}`);
console.log(`- Tarball: ${tarPath}`);
console.log(`- current.tgz -> ${readlinkAbs(currentTgz)}`);
console.log(`- previous.tgz -> ${readlinkAbs(previousTgz)}`);
