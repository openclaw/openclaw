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

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findRunIdForTag({ logStream, ghRepo, wf, releaseTag, timeoutMs = 180000 }) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt++;
    let runId = "";
    try {
      runId = sh("gh", [
        "run",
        "list",
        "--repo",
        ghRepo,
        "--workflow",
        wf,
        "--event",
        "push",
                "--limit",
        "20",
        "--json",
        "databaseId,headBranch",
        "--jq",
        // Prefer the tag push run (headBranch==releaseTag); fallback to latest
        ` (map(select(.headBranch=="${releaseTag}")) | .[0].databaseId) // .[0].databaseId `,
      ]);
    } catch (e) {
      // ignore and retry
    }
    if (runId) {
      banner(logStream, `Found run id: ${runId}`);
      return runId;
    }
    const delay = Math.min(5000, 500 + attempt * 250);
    banner(logStream, `Run not visible yet (attempt ${attempt}); retrying in ${delay}ms`);
    await sleepMs(delay);
  }
  fail(`could not find workflow run for tag ${releaseTag} within ${timeoutMs}ms`);
}

function banner(logStream, s) {
  const line = `\n==> ${s}\n`;
  process.stdout.write(line);
  teeWriteStream(logStream, line);
}


function inferGhRepoFromOrigin() {
  // Supports: git@github.com:owner/repo.git OR https://github.com/owner/repo.git
  const url = sh("git", ["remote", "get-url", "origin"]);
  const m1 = url.match(/github\.com[:/](.+?)\.git$/);
  if (m1) return m1[1];
  const m2 = url.match(/github\.com[:/](.+?)$/);
  if (m2) return m2[1];
  fail(`could not infer GitHub repo from origin url: ${url}`);
}

function computeNextReleaseTag() {
  // base version comes from package.json
  const ver = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  // next poly is global max + 1
  const tags = sh("git", ["tag", "-l", "v*+poly.*"]);
  let maxN = -1;
  for (const line of tags.split(/\r?\n/)) {
    const m = line.match(/\+poly\.(\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > maxN) maxN = n;
  }
  const nextN = maxN + 1;
  return `v${ver}+poly.${nextN}`;
}

function parseArgs(argv) {
  // Supported:
  //   node scripts/polytropos-release.mjs release [--tag v<ver>+poly.<N>] [--repo <owner/repo>] [--workflow <workflow.yml>] [--log <path>]
  const args = argv.slice(2);
  const cmd = args[0] || "";
  let logPath = process.env.POLYTROPOS_RELEASE_LOG || defaultLogPath();
  let repo = null;
  let workflow = null;
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
    if (a === "--workflow") {
      const v = args[i + 1];
      if (!v) fail("--workflow requires a filename (e.g. polytropos-build-pack.yml)");
      workflow = v;
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
    if (a === "--help" || a === "-h") {
      return { cmd: "--help", logPath, repo, workflow, releaseTag };
    }
    fail(`unknown argument: ${a}`);
  }

  return { cmd, logPath, repo, workflow, releaseTag };
}

function usage() {
  console.log(`polytropos-release.mjs

Usage:
  node scripts/polytropos-release.mjs release [--tag v<ver>+poly.<N>] [--repo <owner/repo>] [--workflow <workflow.yml>] [--log <path>]

Behavior (single flow):
  - Pushes the release tag to GitHub
  - Waits for the GitHub Actions workflow run for that tag to complete
  - Downloads the artifact openclaw-tgz-<tag>
  - Stages it into ~/polytropos/releases/<tag>.tgz
  - Updates previous.tgz then current.tgz (symlink-safe)
  - Installs current.tgz globally and runs the bundled deps helper
  - Does not activate/restart the gateway
`);
}

const { cmd, logPath, repo, workflow, releaseTag } = parseArgs(process.argv);
if (!cmd || cmd === "--help") {
  usage();
  process.exit(0);
}

if (cmd !== "release") {
  fail(`unknown command: ${cmd}`);
}

if (!releaseTag) {
  releaseTag = computeNextReleaseTag();
}
if (!/^v[^+]+\+poly\.\d+$/.test(releaseTag)) {
  fail(`invalid --tag: ${releaseTag} (expected v<ver>+poly.<N>)`);
}

fs.mkdirSync(path.dirname(logPath), { recursive: true });
const logStream = fs.createWriteStream(logPath, { flags: "a" });
banner(logStream, `Log file: ${logPath}`);

const ghRepo = repo || inferGhRepoFromOrigin();
const wf = workflow || "polytropos-build-pack.yml";

banner(logStream, `GitHub repo: ${ghRepo}`);
banner(logStream, `Workflow: ${wf}`);
banner(logStream, `Release tag: ${releaseTag}`);

// Ensure release store is consistent before we touch it
const relRoot = releasesRoot();
fs.mkdirSync(relRoot, { recursive: true });
assertReleaseStoreConsistent(relRoot);

// Create tag locally if missing, then push tag
try {
  sh("git", ["rev-parse", "--verify", `refs/tags/${releaseTag}`]);
} catch {
  banner(logStream, `Creating tag locally: ${releaseTag}`);
  await shTee(logStream, "git", ["tag", "-a", releaseTag, "-m", `Polytropos release ${releaseTag}`]);
}

banner(logStream, `Pushing tag: ${releaseTag}`);
await shTee(logStream, "git", ["push", "origin", releaseTag]);

// Dispatch workflow explicitly for this tag (avoids tag-push trigger flakes)
banner(logStream, "Dispatching workflow...");
await shTee(logStream, "gh", ["api", "-X", "POST", `/repos/${ghRepo}/actions/workflows/${wf}/dispatches`, "-f", `ref=${releaseTag}`]);

// Locate the workflow run (eventual consistency: retry)
banner(logStream, "Locating workflow run...");
const runId = await findRunIdForTag({ logStream, ghRepo, wf, releaseTag });

banner(logStream, `Watching run: ${runId}`);
await shTee(logStream, "gh", ["run", "watch", runId, "--repo", ghRepo, "--exit-status"]);

// Download artifact openclaw-tgz-<tag>
const artifact = `openclaw-tgz-${releaseTag}`;
const tmpDir = fs.mkdtempSync(path.join(resolveHome(), ".openclaw", "tmp-release-"));

banner(logStream, `Downloading artifact ${artifact} to ${tmpDir}`);
await shTee(logStream, "gh", [
  "run",
  "download",
  runId,
  "--repo",
  ghRepo,
  "-n",
  artifact,
  "--dir",
  tmpDir,
]);

function findTgz(dir) {
  const matches = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const pth = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(pth);
      else if (ent.isFile() && ent.name.endsWith(".tgz")) matches.push(pth);
    }
  }
  return matches;
}

const tgzs = findTgz(tmpDir);
if (tgzs.length !== 1) {
  fail(`expected exactly one .tgz in artifact, found ${tgzs.length}: ${tgzs.join(", ")}`);
}
const tgzPath = tgzs[0];

// Validate tgz internal version matches tag version
{
  const info = tgzInternalVersion(tgzPath);
  if (info.name !== "openclaw") {
    fail(`unexpected package name in tgz: ${info.name}`);
  }
  const expectedVersion = releaseTag.replace(/^v/, "").replace(/\+poly\.\d+$/, "");
  if (info.version !== expectedVersion) {
    fail(`tgz version ${info.version} != expected ${expectedVersion} (from ${releaseTag})`);
  }
}

const tarPath = path.join(relRoot, `${releaseTag}.tgz`);
if (fs.existsSync(tarPath)) {
  banner(logStream, `Tarball already staged: ${tarPath}`);
  // Validate existing tarball matches expected version
  const info = tgzInternalVersion(tarPath);
  const expectedVersion = releaseTag.replace(/^v/, "").replace(/\+poly\.\d+$/, "");
  if (info.name !== "openclaw") {
    fail(`unexpected package name in existing tgz: ${info.name}`);
  }
  if (info.version !== expectedVersion) {
    fail(`existing tgz version ${info.version} != expected ${expectedVersion} (from ${releaseTag})`);
  }
} else {
  fs.copyFileSync(tgzPath, tarPath);
  banner(logStream, `Staged tarball: ${tarPath}`);
}

banner(logStream, `Staged tarball: ${tarPath}`);

// Update symlinks: previous.tgz then current.tgz
const currentTgz = path.join(relRoot, "current.tgz");
assertSymlink(currentTgz, "current.tgz");
const previousTgz = path.join(relRoot, "previous.tgz");
assertSymlink(previousTgz, "previous.tgz");
const currentTarget = readlinkAbs(currentTgz);
if (currentTarget) {
  banner(logStream, `Setting previous.tgz -> ${currentTarget}`);
  lnSfn(currentTarget, previousTgz);
} else {
  banner(logStream, "No existing current.tgz symlink; setting previous.tgz to this tarball as bootstrap");
  lnSfn(tarPath, previousTgz);
}

banner(logStream, `Setting current.tgz -> ${tarPath}`);
lnSfn(tarPath, currentTgz);

// Install globally
const prefix = getGlobalPrefix();
banner(logStream, `Installing globally into prefix: ${prefix}`);
// Safety: move aside any existing global install dir to avoid partial/dirty trees after crashes
  {
    const npmRoot = sh("npm", ["root", "-g", "--prefix", prefix]);
    const installedRoot = path.join(npmRoot, "openclaw");
    if (fs.existsSync(installedRoot)) {
      const bak = `${installedRoot}.bak-${timestampForFilename()}`;
      banner(logStream, `Moving aside existing global install: ${installedRoot} -> ${bak}`);
      fs.renameSync(installedRoot, bak);
    }
  }

await shTee(logStream, "npm", ["install", "-g", "--prefix", prefix, currentTgz]);

// Run bundled deps helper
banner(logStream, "Running Polytropos bundled plugin deps helper...");
{
  const npmRoot = sh("npm", ["root", "-g", "--prefix", prefix]);
  const installedRoot = path.join(npmRoot, "openclaw");
  const helperPath = path.join(installedRoot, "scripts", "polytropos-bundled-plugin-deps-helper.mjs");
  if (!fs.existsSync(helperPath)) {
    fail(`Polytropos helper not found at ${helperPath}`);
  }
  await shTee(logStream, "node", [helperPath]);
  banner(logStream, "Bundled plugin deps helper completed.");
}

banner(logStream, "Activation required: restart the gateway to run the new code");
banner(logStream, "Release staged (not activated).");
logStream.end();
