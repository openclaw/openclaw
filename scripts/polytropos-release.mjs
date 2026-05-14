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
 * - Release always switches `previous.tgz` then `current.tgz` (mandatory) and installs `current.tgz` globally. Gateway activation/restart is a separate step.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function timestampForFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function resolveHome() {
  return process.env.HOME || "/home/ec2-user";
}

function defaultLogPath() {
  const logsDir = path.join(resolveHome(), ".openclaw", "logs");
  return path.join(logsDir, `polytropos-release-${timestampForFilename()}.log`);
}

function parseArgs(argv) {
  // Supported:
  //   node scripts/polytropos-release.mjs release [--log <path>]
  const args = argv.slice(2);
  const cmd = args[0] || "";
  let logPath = process.env.POLYTROPOS_RELEASE_LOG || defaultLogPath();
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--log") {
      const v = args[i + 1];
      if (!v) {
        fail("--log requires a path");
      }
      logPath = v;
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") {
      return { cmd: "--help", logPath };
    }
    fail(`unknown argument: ${a}`);
  }
  return { cmd, logPath };
}

function teeWriteStream(logStream, chunk) {
  try {
    logStream.write(chunk);
  } catch {}
}

async function shTee(logStream, cmd, args, opts = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      teeWriteStream(logStream, chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      teeWriteStream(logStream, chunk);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `command failed: ${cmd} ${args.join(" ")} (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
  });
}

function banner(logStream, s) {
  const line = `\n==> ${s}\n`;
  process.stdout.write(line);
  teeWriteStream(logStream, line);
}

function getRepoRoot() {
  return sh("git", ["rev-parse", "--show-toplevel"]);
}

function getNearestReachableReleaseTag() {
  // Use the nearest reachable release tag from HEAD. This can be either:
  //   - upstream tag: v<ver>
  //   - polytropos tag: v<ver>+poly.<N>
  //
  // We intentionally do not require the nearest tag to be "upstream-only"; HEAD may be based on a prior poly release.
  let tag = "";
  try {
    tag = sh("git", ["describe", "--tags", "--match", "v*", "--abbrev=0"]);
  } catch {
    fail(
      "no reachable v* release tag found from HEAD; fetch tags and ensure history includes a v<ver> or v<ver>+poly.<N> tag",
    );
  }
  return tag;
}

function parseReleaseTag(tag) {
  // Accepted forms:
  //   v<ver>
  //   v<ver>+poly.<N>
  //
  // We treat the base upstream version as the v<ver> prefix (even when the nearest reachable tag is itself a poly tag).
  const m = tag.match(/^(v[^+]+)(?:\+poly\.(\d+))?$/);
  if (!m) {
    fail(
      `nearest reachable v* tag (${tag}) did not match expected release tag formats (v<ver> or v<ver>+poly.<N>)`,
    );
  }
  return { baseUpstreamTag: m[1], polyBuild: m[2] ? Number(m[2]) : null };
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

function ensureHooksDisabled(repoRoot, logStream, reason) {
  const disabledDirName = "git-hooks-disabled";
  const disabledDirAbs = path.join(repoRoot, disabledDirName);
  fs.mkdirSync(disabledDirAbs, { recursive: true });
  banner(logStream, `Disabling git hooks (${reason}) via core.hooksPath=${disabledDirName}`);
  sh("git", ["config", "core.hooksPath", disabledDirName], { cwd: repoRoot });
}

function getGlobalPrefix() {
  // This host uses ~/.npm-global; keep it explicit so installs land where systemd expects.
  return "/home/ec2-user/.npm-global";
}

function npmPack(repoRoot, outDir, tarballName) {
  fs.mkdirSync(outDir, { recursive: true });
  const listTgzs = () => {
    try {
      return new Set(
        fs
          .readdirSync(outDir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".tgz"))
          .map((e) => e.name),
      );
    } catch {
      return new Set();
    }
  };

  // `npm pack` usually prints the tarball filename to stdout, but stdout can be noisy in practice.
  // Prefer detecting the actual produced artifact(s) in `outDir` reliably.
  const before = listTgzs();
  const stdout = execFileSync("npm", ["pack", "--silent", "--pack-destination", outDir], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const after = listTgzs();

  const created = [...after].filter((name) => !before.has(name));
  let producedName = created.length === 1 ? String(created[0]) : null;

  if (!producedName) {
    // Defensive parsing fallback: pick the last non-empty line that looks like a tarball name.
    // Some npm configurations/plugins print additional content to stdout.
    const lines = String(stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const lastTgz = [...lines].toReversed().find((l) => l.endsWith(".tgz"));
    if (lastTgz) {
      const candidate = path.basename(lastTgz);
      if (after.has(candidate)) {
        producedName = candidate;
      }
    }
  }

  if (!producedName) {
    const createdList = created.length ? created.join(", ") : "(none)";
    fail(
      `failed to identify npm pack output tarball in ${outDir} (created=${createdList}; stdout=${JSON.stringify(stdout)})`,
    );
  }

  const produced = path.join(outDir, producedName);
  if (!fs.existsSync(produced)) {
    fail(`npm pack produced ${producedName} but file not found at ${produced}`);
  }

  const target = path.join(outDir, tarballName);
  fs.rmSync(target, { force: true });
  fs.renameSync(produced, target);
  return target;
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
  node scripts/polytropos-release.mjs release [--log <path>]

Behavior:
  - Requires clean git working tree
  - Uses the nearest reachable release tag (v<ver> or v<ver>+poly.<N>) to derive the base upstream version (v<ver>)
  - Computes next global poly build number N = max(existing poly) + 1
  - Creates tag v<ver>+poly.<N> at HEAD
  - Builds using: pnpm install; pnpm ui:build; pnpm build
  - Produces tarball via npm pack: ~/polytropos/releases/v<ver>+poly.<N>.tgz
  - Updates ~/polytropos/releases/previous.tgz -> old current.tgz (if present)
  - Updates ~/polytropos/releases/current.tgz -> new tarball
  - Installs current.tgz globally into /home/ec2-user/.npm-global
  - Does not restart/activate the gateway (run: systemctl --user restart openclaw-gateway)
`);
}

const { cmd, logPath } = parseArgs(process.argv);
if (!cmd || cmd === "--help") {
  usage();
  process.exit(0);
}

if (cmd !== "release") {
  fail(`unknown command: ${cmd}`);
}

fs.mkdirSync(path.dirname(logPath), { recursive: true });
const logStream = fs.createWriteStream(logPath, { flags: "a" });
banner(logStream, `Log file: ${logPath}`);

ensureCleanWorkingTree();
const repoRoot = getRepoRoot();
const nearestReleaseTag = getNearestReachableReleaseTag();
const { baseUpstreamTag } = parseReleaseTag(nearestReleaseTag);

const maxPoly = getMaxPolyBuildNumber();
const nextPoly = maxPoly + 1;
const polyTag = `${baseUpstreamTag}+poly.${nextPoly}`;

banner(logStream, `Nearest reachable release tag: ${nearestReleaseTag}`);
banner(logStream, `Upstream base tag (derived): ${baseUpstreamTag}`);
banner(logStream, `Next release tag: ${polyTag}`);

// Create annotated tag
banner(logStream, `git tag -a ${polyTag}`);
await shTee(logStream, "git", ["tag", "-a", polyTag, "-m", `Polytropos release ${polyTag}`]);

// Build dist/
banner(logStream, "Building dist/");
ensureHooksDisabled(repoRoot, logStream, "before pnpm install");
await shTee(logStream, "pnpm", ["install"], { cwd: repoRoot });
// `pnpm install` runs the repo `prepare` script, which sets core.hooksPath to `git-hooks`.
// Re-disable hooks explicitly so the release flow never leaves hooks enabled on the host.
ensureHooksDisabled(repoRoot, logStream, "after pnpm install (prepare may reset core.hooksPath)");
await shTee(logStream, "pnpm", ["ui:build"], { cwd: repoRoot });
await shTee(logStream, "pnpm", ["build"], { cwd: repoRoot });

ensureDistExists(repoRoot);

// Produce tarball into releases
const relRoot = releasesRoot();
fs.mkdirSync(relRoot, { recursive: true });
const tarName = `${polyTag}.tgz`;
const tarPath = npmPack(repoRoot, relRoot, tarName);
banner(logStream, `Packed tarball: ${tarPath}`);

// Update symlinks: previous.tgz then current.tgz (mandatory)
const currentTgz = path.join(relRoot, "current.tgz");
const previousTgz = path.join(relRoot, "previous.tgz");
const currentTarget = readlinkAbs(currentTgz);
if (currentTarget) {
  banner(logStream, `Setting previous.tgz -> ${currentTarget}`);
  lnSfn(currentTarget, previousTgz);
} else {
  banner(
    logStream,
    "No existing current.tgz symlink; setting previous.tgz to this tarball as bootstrap",
  );
  lnSfn(tarPath, previousTgz);
}

banner(logStream, `Setting current.tgz -> ${tarPath}`);
lnSfn(tarPath, currentTgz);

// Install tarball globally into the prefix used by systemd
const prefix = getGlobalPrefix();
banner(logStream, `Installing globally into prefix: ${prefix}`);
await shTee(logStream, "npm", ["install", "-g", "--prefix", prefix, currentTgz]);

// Run the Polytropos-owned bundled plugin deps helper from the installed package.
banner(logStream, "Running Polytropos bundled plugin deps helper...");
{
  const npmRoot = sh("npm", ["root", "-g", "--prefix", prefix]);
  const pkgName = sh("node", ["-p", "require('./package.json').name"], { cwd: repoRoot });
  const installedRoot = path.join(npmRoot, pkgName);
  const helperPath = path.join(
    installedRoot,
    "scripts",
    "polytropos-bundled-plugin-deps-helper.mjs",
  );
  if (!fs.existsSync(helperPath)) {
    fail(`Polytropos helper not found at ${helperPath}`);
  }
  await shTee(logStream, "node", [helperPath]);
}

banner(
  logStream,
  "Activation required: restart gateway to run the new code (systemctl --user restart openclaw-gateway)",
);

banner(logStream, "Release staged (not activated).");
banner(logStream, `- Tag: ${polyTag}`);
banner(logStream, `- Tarball: ${tarPath}`);
banner(logStream, `- current.tgz -> ${readlinkAbs(currentTgz)}`);
banner(logStream, `- previous.tgz -> ${readlinkAbs(previousTgz)}`);
banner(logStream, "- Next: systemctl --user restart openclaw-gateway");

logStream.end();
