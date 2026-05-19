function usage() {
  console.log(`polytropos-release.mjs

Usage:
  node scripts/polytropos-release.mjs release --tag v<ver>+poly.<N> [--repo <owner/repo>] [--log <path>]

Behavior (single flow):
  - (main) creates and pushes the release tag
  - waits for the GitHub Actions tag build to finish (gh run watch)
  - downloads the resulting artifact
  - stages it into ~/polytropos/releases/<tag>.tgz
  - updates previous.tgz then current.tgz
  - installs current.tgz globally and runs the bundled deps helper
  - does not activate/restart the gateway
`);
}

#!/usr/bin/env node
/**
 * Polytropos core release script (single purpose)
 *
 * ONE job:
 *   Download a CI-built release artifact from GitHub Actions and stage it into the
 *   authoritative local release store under ~/polytropos/releases/, then install it globally.
 *
 * Notes:
 * - No local builds.
 * - No git tagging.
 * - Artifact naming is the source of truth for the release tag (v<ver>+poly.<N>).
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
  const logsDir = path.join(resolveHome(), ".openclaw", "logs", "polytropos-release");
  return path.join(logsDir, `polytropos-release-${timestampForFilename()}.log`);
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

function assertSymlink(p, what) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) {
      fail(`${what} must be a symlink at ${p}`);
    }
  } catch {
    // ok if missing
  }
}

function tgzInternalVersion(tgzPath) {
  const raw = execFileSync("tar", ["-xOzf", tgzPath, "package/package.json"], {
    encoding: "utf8",
  });
  const obj = JSON.parse(raw);
  return { name: obj?.name, version: obj?.version };
}

function assertReleaseStoreConsistent(relRoot) {
  if (!fs.existsSync(relRoot)) return;
  const entries = fs.readdirSync(relRoot, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.startsWith("v") || !e.name.endsWith(".tgz")) continue;
    const m = e.name.match(/^v([^+]+)(?:\+poly\.\d+)?\.tgz$/);
    if (!m) continue;
    const expected = m[1];
    const full = path.join(relRoot, e.name);
    const info = tgzInternalVersion(full);
    if (info.name !== "openclaw") {
      fail(`release store corruption: ${e.name} package name ${info.name}`);
    }
    if (info.version !== expected) {
      fail(
        `release store corruption: ${e.name} contains version ${info.version} (expected ${expected})`,
      );
    }
  }
}

function getGlobalPrefix() {
  // Prefer explicit npm prefix; else default to ~/.npm-global used by the gateway service.
  const p = process.env.OPENCLAW_GLOBAL_PREFIX;
  if (p) return p;
  return path.join(resolveHome(), ".npm-global");
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

function parseArgs(argv) {
  // Supported:
  //   node scripts/polytropos-release.mjs release --run <run-id> [--repo <owner/repo>] [--artifact <name>] [--log <path>]
  //   node scripts/polytropos-release.mjs release --run-url <actions-run-url> [--repo <owner/repo>] [--artifact <name>] [--log <path>]
  const args = argv.slice(2);
  const cmd = args[0] || "";
  let logPath = process.env.POLYTROPOS_RELEASE_LOG || defaultLogPath();
  let repo = null;
  let runId = null;
  let runUrl = null;
  let artifactName = null;
  let releaseTag = null;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--log") {
      const v = args[i + 1];
      if (!v) fail("--log requires a path");
      logPath = v;
      i++;
      continue;
    }
    if (a === "--repo") {
      const v = args[i + 1];
      if (!v) fail("--repo requires owner/repo");
      repo = v;
      i++;
      continue;
    }
    if (a === "--run") {
      const v = args[i + 1];
      if (!v) fail("--run requires a run id");
      runId = v;
      i++;
      continue;
    }
    if (a === "--run-url") {
      const v = args[i + 1];
      if (!v) fail("--run-url requires a URL");
      runUrl = v;
      i++;
      continue;
    }

    if (a === "--tag") {
      const v = args[i + 1];
      if (!v) fail("--tag requires v<ver>+poly.<N>");
      releaseTag = v;
      i++;
      continue;
    }

    if (a === "--artifact") {
      const v = args[i + 1];
      if (!v) fail("--artifact requires a name");
      artifactName = v;
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") {
      return { cmd: "--help", logPath, repo, runId, runUrl, artifactName, releaseTag };
    }
    fail(`unknown argument: ${a}`);
  }
  return { cmd, logPath, repo, runId, runUrl, artifactName, releaseTag };
}

