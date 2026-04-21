import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function runInstalledCliJson(args, env, packageRoot) {
  const result = spawnSync(process.execPath, [join(packageRoot, "openclaw.mjs"), ...args], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = result.stdout.trim() || result.stderr.trim();
  assert.notEqual(output, "", `expected output from installed CLI: ${args.join(" ")}`);
  return JSON.parse(output);
}

function resolveInstalledRuntimeInternalModule(packageRoot) {
  const distDir = join(packageRoot, "dist");
  const matches = readdirSync(distDir)
    .filter((entry) => /^runtime-internal-.*\.js$/u.test(entry))
    .toSorted((left, right) => left.localeCompare(right));
  assert.notEqual(matches.length, 0, `missing runtime-internal build chunk under ${distDir}`);
  return join("dist", matches[0]);
}

async function loadInstalledDurableJobRuntime(packageRoot) {
  const relativeModulePath = resolveInstalledRuntimeInternalModule(packageRoot);
  const modulePath = join(packageRoot, relativeModulePath);
  const source = readFileSync(modulePath, "utf8");
  const createAlias = source.match(/createDurableJobRecord as (\w+)/u)?.[1];
  const recordAlias = source.match(/recordDurableJobTransition as (\w+)/u)?.[1];
  assert.ok(createAlias, `missing createDurableJobRecord export alias in ${modulePath}`);
  assert.ok(recordAlias, `missing recordDurableJobTransition export alias in ${modulePath}`);

  const runtime = await import(pathToFileURL(modulePath).href);
  assert.equal(
    typeof runtime[createAlias],
    "function",
    `missing createDurableJobRecord export in ${modulePath}`,
  );
  assert.equal(
    typeof runtime[recordAlias],
    "function",
    `missing recordDurableJobTransition export in ${modulePath}`,
  );
  return {
    createDurableJobRecord: runtime[createAlias],
    recordDurableJobTransition: runtime[recordAlias],
  };
}

export async function runInstalledJobsCliPersistenceSmoke(params) {
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-jobs-cli-persistence-smoke-"));
  const homeDir = join(tempRoot, "home");
  const stateDir = join(tempRoot, "state");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_SUPPRESS_NOTES: "1",
    OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
  };
  delete env.OPENCLAW_HOME;
  delete env.OPENCLAW_CONFIG_PATH;
  delete env.VITEST;

  const snapshot = {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    stateDir: process.env.OPENCLAW_STATE_DIR,
  };
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.OPENCLAW_HOME;

  try {
    const runtime = await loadInstalledDurableJobRuntime(params.packageRoot);
    const job = runtime.createDurableJobRecord({
      jobId: "job-installed-cli-proof",
      title: "Installed CLI proof",
      goal: "Verify packaged openclaw.mjs can read durable jobs persisted before launch",
      ownerSessionKey: "agent:main:main",
      status: "waiting",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes", onCompletion: true },
      currentStep: "await_installed_cli",
      summary: "Persisted before packaged CLI launch",
      nextWakeAt: 900,
      backing: {
        taskFlowId: "flow-installed-cli-proof",
        childSessionKeys: ["agent:coder:subagent:proof"],
      },
      source: { kind: "chat_commitment", messageText: "I'll keep watching this." },
      createdBy: "release-smoke",
      createdAt: 100,
      updatedAt: 120,
    });
    runtime.recordDurableJobTransition({
      jobId: job.jobId,
      to: "waiting",
      reason: "Seeded for packaged CLI persistence smoke",
      actor: "release-smoke",
      at: 121,
      disposition: { kind: "notify_and_schedule", notify: true, nextWakeAt: 900 },
      revision: job.audit.revision,
    });

    const listed = runInstalledCliJson(["jobs", "list", "--json"], env, params.packageRoot);
    assert.equal(listed.count, 1, `expected one durable job, got ${JSON.stringify(listed)}`);
    assert.equal(Array.isArray(listed.jobs), true, "expected jobs list array");
    const [listedJob] = listed.jobs;
    assert.equal(listedJob?.jobId, "job-installed-cli-proof");
    assert.equal(listedJob?.status, "waiting");
    assert.equal(listedJob?.currentStep, "await_installed_cli");
    assert.equal(listedJob?.summary, "Persisted before packaged CLI launch");
    assert.equal(listedJob?.nextWakeAt, 900);
    assert.equal(listedJob?.backing?.taskFlowId, "flow-installed-cli-proof");
    assert.deepEqual(listedJob?.backing?.childSessionKeys, ["agent:coder:subagent:proof"]);

    const shown = runInstalledCliJson(
      ["jobs", "show", "job-installed-cli-proof", "--json"],
      env,
      params.packageRoot,
    );
    assert.equal(shown.jobId, "job-installed-cli-proof");
    assert.equal(shown.status, "waiting");
    assert.equal(shown.currentStep, "await_installed_cli");
    assert.equal(shown.backing?.taskFlowId, "flow-installed-cli-proof");
    assert.equal(shown.source?.kind, "chat_commitment");
    assert.equal(Array.isArray(shown.history), true, "expected transition history array");
    const [transition] = shown.history;
    assert.equal(transition?.jobId, "job-installed-cli-proof");
    assert.equal(transition?.to, "waiting");
    assert.equal(transition?.reason, "Seeded for packaged CLI persistence smoke");
    assert.equal(transition?.actor, "release-smoke");
    assert.equal(transition?.revision, 0);
    assert.equal(transition?.disposition?.kind, "notify_and_schedule");
    assert.equal(transition?.disposition?.nextWakeAt, 900);
  } finally {
    if (snapshot.home === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = snapshot.home;
    }
    if (snapshot.userProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = snapshot.userProfile;
    }
    if (snapshot.stateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = snapshot.stateDir;
    }
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}
