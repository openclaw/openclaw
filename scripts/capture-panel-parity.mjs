#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baselineSha = "171df4e1c5a08e1da631c4fff50c420db2bb6f84";
const fixturePath = "scripts/fixtures/control-ui-panel-proof";
const checkout = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const shaPattern = /^[0-9a-f]{40}$/;

function readGit(...args) {
  const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("Could not inspect the admitted CI checkout");
  }
  return result.stdout.trim();
}

function requireSha(name) {
  const value = process.env[name];
  if (!value || !shaPattern.test(value)) {
    throw new Error(`${name} must be a full commit SHA`);
  }
  return value;
}

// PR CI supplies both identities; a tested merge must directly include that PR
// head, while an exact-head checkout may equal it.
const checkoutSha = requireSha("EXPECTED_CHECKOUT_SHA");
const prHeadSha = requireSha("EXPECTED_PR_HEAD_SHA");
if (requireSha("EXPECTED_BASELINE_SHA") !== baselineSha) {
  throw new Error("Baseline pin changed");
}
if (readGit("rev-parse", "HEAD") !== checkoutSha) {
  throw new Error("CI checkout SHA mismatch");
}
if (fs.realpathSync(process.cwd()) !== checkout) {
  throw new Error("Run from the CI checkout root");
}
if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
  throw new Error("Panel parity requires PR CI");
}
const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
if (event.pull_request?.head?.sha !== prHeadSha) {
  throw new Error("PR event head SHA mismatch");
}
const parents = readGit("cat-file", "-p", checkoutSha)
  .split("\n\n", 1)[0]
  .split("\n")
  .filter((line) => line.startsWith("parent "))
  .map((line) => line.slice(7));
if (checkoutSha !== prHeadSha && !parents.includes(prHeadSha)) {
  throw new Error("Tested checkout does not directly include the expected PR head");
}

const runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP);
const gitOwner = process.env.CI_GIT_OWNER || path.join(runnerTemp, "ci-git-owner.py");
if (!fs.statSync(gitOwner).isFile()) {
  throw new Error("Native CI Git owner is unavailable");
}
const parent = path.join(checkout, ".artifacts/panel-parity");
fs.mkdirSync(parent, { recursive: true });
const output = fs.mkdtempSync(path.join(parent, "run-"));
const privateLogs = path.join(output, ".logs");
fs.mkdirSync(privateLogs);
const temporary = fs.mkdtempSync(path.join(runnerTemp, "panel-parity-"));
const baselineCheckout = path.join(temporary, "baseline");
const manifest = {
  version: 1,
  baselineSha,
  checkoutSha,
  prHeadSha,
  baseline: { outcome: "pending", phase: "setup", exitCode: null },
  candidate: { outcome: "pending", phase: "capture", exitCode: null },
  cleanup: "pending",
  expectedImagesPerRevision: 24 * 4 * 2,
  images: [],
};

function saveManifest() {
  fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function run(command, args, { cwd = checkout, env = process.env, log }) {
  const stream = fs.createWriteStream(log, { flags: "a" });
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    for (const source of [child.stdout, child.stderr]) {
      source.on("data", (chunk) => {
        stream.write(chunk);
        process.stdout.write(chunk);
      });
    }
    let spawnFailed = false;
    child.on("error", () => {
      spawnFailed = true;
    });
    child.on("close", (code) => {
      stream.end(() => resolve(spawnFailed ? 1 : (code ?? 1)));
    });
  });
}

async function ownerGit(args, log) {
  const code = await run("python3", ["-I", "-S", gitOwner, "--git", "0", ...args], { log });
  if (code !== 0) {
    throw new Error("Native Git owner operation failed");
  }
}

async function copyDependencies(log) {
  const queue = [checkout];
  for (const directory of queue) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      if ([".git", ".artifacts", ".local", ".ci-harness"].includes(entry.name)) {
        continue;
      }
      const source = path.join(directory, entry.name);
      if (entry.name !== "node_modules") {
        queue.push(source);
        continue;
      }
      const target = path.join(baselineCheckout, path.relative(checkout, source));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const code = await run("cp", ["-a", "--reflink=auto", source, target], { log });
      if (code !== 0) {
        throw new Error("Could not copy the baseline dependency tree");
      }
    }
  }
}

async function capture(revision, cwd) {
  const artifacts = path.join(output, revision);
  fs.mkdirSync(artifacts);
  const env = {
    ...process.env,
    CI: "1",
    OPENCLAW_UI_E2E_ARTIFACT_DIR: artifacts,
    OPENCLAW_UI_E2E_DIAGNOSTIC_DIR: path.join(output, ".private-diagnostics", revision),
  };
  // Normal E2E shard selectors belong to the preceding workflow step, never to
  // this explicit one-worker fixture invocation.
  delete env.OPENCLAW_VITEST_INCLUDE_FILE;
  delete env.VITEST_SHARD_INDEX;
  delete env.VITEST_SHARD_COUNT;
  delete env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM;
  const exitCode = await run(
    process.execPath,
    [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      `${fixturePath}/vitest.config.ts`,
      "--configLoader",
      "runner",
      `${fixturePath}/panel-parity.e2e.test.ts`,
      "--maxWorkers=1",
    ],
    { cwd, env, log: path.join(privateLogs, `${revision}.log`) },
  );
  manifest[revision] = { outcome: exitCode === 0 ? "pass" : "fail", phase: "capture", exitCode };
  saveManifest();
}

function collectImages(revision) {
  const root = path.join(output, revision);
  if (!fs.existsSync(root)) {
    return;
  }
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    const variant = /^wpg5a-(desktop|mobile)-(light|dark)-/.exec(directory.name);
    if (!directory.isDirectory() || !variant) {
      continue;
    }
    for (const entry of fs.readdirSync(path.join(root, directory.name), { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-z0-9-]+\.png$/.test(entry.name)) {
        continue;
      }
      const filename = path.join(root, directory.name, entry.name);
      const png = fs.readFileSync(filename);
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error("Capture did not produce a PNG");
      }
      manifest.images.push({
        revision,
        viewport: variant[1],
        theme: variant[2],
        state: entry.name.replace(/(?:-panel)?\.png$/, ""),
        kind: entry.name.endsWith("-panel.png") ? "panel" : "page",
        file: path.relative(output, filename).split(path.sep).join("/"),
        bytes: png.length,
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        sha256: createHash("sha256").update(png).digest("hex"),
      });
    }
  }
}

console.log(`Panel parity evidence: ${path.relative(checkout, output)}`);
saveManifest();
try {
  const setupLog = path.join(privateLogs, "baseline-setup.log");
  try {
    if (readGit("rev-parse", `${baselineSha}^{commit}`) !== baselineSha) {
      throw new Error("Baseline object unavailable");
    }
    await ownerGit(["worktree", "add", "--detach", baselineCheckout, baselineSha], setupLog);
    if (
      !fs
        .readFileSync(path.join(baselineCheckout, "pnpm-lock.yaml"))
        .equals(fs.readFileSync(path.join(checkout, "pnpm-lock.yaml")))
    ) {
      throw new Error("Baseline lockfile differs from the admitted dependency installation");
    }
    await copyDependencies(setupLog);
    const targetFixture = path.join(baselineCheckout, fixturePath);
    if (fs.existsSync(targetFixture)) {
      throw new Error("Baseline already contains the temporary fixture");
    }
    fs.cpSync(path.join(checkout, fixturePath), targetFixture, { recursive: true });
    await capture("baseline", baselineCheckout);
  } catch (error) {
    fs.appendFileSync(
      setupLog,
      `${error instanceof Error ? error.message : "Baseline capture failed"}\n`,
    );
    manifest.baseline = { outcome: "fail", phase: "setup-or-capture", exitCode: null };
    saveManifest();
    console.error(
      "Baseline capture failed; continuing with candidate. Retained local logs contain the cause.",
    );
  }
  try {
    if (readGit("rev-parse", "HEAD") !== checkoutSha) {
      throw new Error("Candidate checkout changed");
    }
    await capture("candidate", checkout);
    if (readGit("rev-parse", "HEAD") !== checkoutSha) {
      throw new Error("Candidate checkout changed during capture");
    }
  } catch (error) {
    fs.appendFileSync(
      path.join(privateLogs, "candidate.log"),
      `${error instanceof Error ? error.message : "Candidate capture failed"}\n`,
    );
    manifest.candidate = { outcome: "fail", phase: "capture", exitCode: null };
    saveManifest();
  }
} finally {
  for (const revision of ["baseline", "candidate"]) {
    try {
      collectImages(revision);
    } catch {
      manifest[revision].outcome = "fail";
    }
    if (
      manifest.images.filter((image) => image.revision === revision).length !==
      manifest.expectedImagesPerRevision
    ) {
      manifest[revision].outcome = "fail";
    }
  }
  manifest.images.sort((left, right) => left.file.localeCompare(right.file));
  try {
    if (fs.existsSync(path.join(baselineCheckout, ".git"))) {
      await ownerGit(
        ["worktree", "remove", "--force", baselineCheckout],
        path.join(privateLogs, "cleanup.log"),
      );
    }
    fs.rmdirSync(temporary);
    manifest.cleanup = "pass";
  } catch {
    manifest.cleanup = "fail";
    console.error("Owned baseline worktree cleanup failed; retained setup path is in local logs.");
  }
  saveManifest();
}
console.log(
  `Panel parity: baseline=${manifest.baseline.outcome}, candidate=${manifest.candidate.outcome}, images=${manifest.images.length}`,
);
if (
  manifest.baseline.outcome !== "pass" ||
  manifest.candidate.outcome !== "pass" ||
  manifest.cleanup !== "pass"
) {
  process.exitCode = 1;
}
