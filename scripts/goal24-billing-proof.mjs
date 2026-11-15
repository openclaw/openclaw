// Run only in disposable GitHub-hosted VMs. No source code executes on the
// operator host; checkout credentials and Actions service tokens are excluded.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  classify,
  originalTooling,
  plans,
  sources,
  withSequencer,
} from "./goal24-billing-proof-plan.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.platform, "linux");
const variant = process.env.GOAL24_VARIANT;
const group = process.env.GOAL24_GROUP;
assert.ok(Object.hasOwn(sources, variant));
assert.ok(Object.hasOwn(plans, group));
const plan = plans[group];
const root = process.cwd();
const source = path.join(root, "source");
const output = path.join(root, "proof-output");
fs.mkdirSync(output, { recursive: true });
const isolated = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "goal24-billing-"));
for (const name of ["home", "tmp", "state", "cache", "bun-cache"]) {
  fs.mkdirSync(path.join(isolated, name));
}
const env = Object.fromEntries(
  ["PATH", "PNPM_HOME", "COREPACK_HOME"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
Object.assign(env, {
  HOME: path.join(isolated, "home"),
  TMPDIR: path.join(isolated, "tmp"),
  TMP: path.join(isolated, "tmp"),
  TEMP: path.join(isolated, "tmp"),
  OPENCLAW_STATE_DIR: path.join(isolated, "state"),
  OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(isolated, "cache"),
  OPENCLAW_BUN_CACHE_ROOT: path.join(isolated, "bun-cache"),
  CI: "true",
  GITHUB_ACTIONS: "true",
  RUNNER_OS: "Linux",
  RUNNER_TEMP: isolated,
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  NODE_OPTIONS: "--max-old-space-size=8192",
  OPENCLAW_VITEST_MAX_WORKERS: "2",
  OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
  OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "300000",
});
const summary = {
  variant,
  group,
  originalJob: plan.job,
  sourceSha: sources[variant],
  originalTooling,
  proofTooling: process.env.GITHUB_SHA,
  node: process.version,
  stages: [],
  observations: [],
  outcome: "setup-failure",
};
const save = () =>
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
function run(name, command, args, timeout, cwd = source) {
  const fd = fs.openSync(path.join(output, name + ".log"), "w", 0o600);
  const start = Date.now();
  // GNU timeout owns the command's process group, including grandchildren.
  const result = spawnSync(
    "timeout",
    ["--signal=TERM", "--kill-after=15s", String(timeout) + "s", command, ...args],
    { cwd, env, stdio: ["ignore", fd, fd], timeout: (timeout + 30) * 1000, killSignal: "SIGKILL" },
  );
  fs.closeSync(fd);
  summary.stages.push({
    name,
    command,
    args,
    seconds: (Date.now() - start) / 1000,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
  });
  save();
  assert.ok(
    !result.error && !result.signal && ![124, 137].includes(result.status),
    name + " did not complete within bound",
  );
  return result.status;
}
function capture(command, args, cwd = source) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, command + " preflight failed");
  return result.stdout.trim();
}
try {
  assert.equal(process.version, "v24.22.1");
  for (const [directory, sha] of [
    [source, sources[variant]],
    [path.join(root, "original"), originalTooling],
  ]) {
    assert.equal(capture("git", ["rev-parse", "HEAD"], directory), sha);
    assert.equal(capture("git", ["status", "--porcelain"], directory), "");
    const credentials = spawnSync(
      "git",
      ["config", "--local", "--get-regexp", "http.*extraheader"],
      { cwd: directory, env },
    );
    assert.equal(credentials.status, 1, "checkout retained credentials");
  }
  summary.pnpm = capture("pnpm", ["--version"]);
  assert.equal(summary.pnpm, "12.15.0");
  assert.equal(run("install", "pnpm", ["install", "--frozen-lockfile"], 900), 0);
  const bunRoot = path.join(isolated, "bun");
  assert.equal(
    run(
      "stage-bun",
      "bash",
      [path.join(root, "original/scripts/stage-openclaw-bun.sh"), bunRoot, "linux", "x64"],
      600,
    ),
    0,
  );
  env.OPENCLAW_BUN_PATH = path.join(bunRoot, "bin/bun");
  summary.bun = capture(env.OPENCLAW_BUN_PATH, ["--revision"]);
  if (plan.build) {
    env.OPENCLAW_BUILD_PRIVATE_QA = group === "compaction" ? "1" : "0";
    env.VITEST = "1";
    assert.equal(run("runtime-build", "pnpm", ["build", "qaRuntime"], 900), 0);
    if (group === "compaction") {
      env.OPENCLAW_E2E_USE_PREBUILT_DIST = "1";
    }
    delete env.VITEST;
  }
  // A fixed sequencer and one worker make ordering common to both source pins.
  // This is intentionally not a replay of the original parallel shard load.
  const sequencer = path.join(source, "test/vitest/goal24-billing-sequencer.mjs");
  fs.writeFileSync(
    sequencer,
    'import { BaseSequencer } from "vitest/node";\n' +
      "const files = " +
      JSON.stringify(plan.files) +
      ";\n" +
      "export default class extends BaseSequencer { async sort(specs) { return [...specs].sort((a,b) => files.findIndex(f => a.moduleId.endsWith(f)) - files.findIndex(f => b.moduleId.endsWith(f))); } }\n",
  );
  // Vitest 5 requires a constructor in config; a CLI path remains a string.
  // Keep the original config path and all preparation/selection policies.
  const configPath = path.join(source, plan.config);
  const configText = fs.readFileSync(configPath, "utf8");
  fs.writeFileSync(configPath, withSequencer(configText));
  env.OPENCLAW_NODE_TEST_GROUPS_JSON = JSON.stringify([
    { configs: [plan.config], includePatterns: plan.files, shard_name: "goal24-" + group },
  ]);
  // Keep Node before Bun, the original dual-all order. Separate invocations
  // retain per-runtime reports; omitted shard siblings/load are a stated gap.
  summary.outcome = "incomplete";
  for (const runtime of ["node", "bun"]) {
    env.OPENCLAW_CI_TEST_RUNTIME_POLICY = runtime === "node" ? "node" : "bun-all";
    const report = path.join(output, runtime + ".json");
    env.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON = JSON.stringify([
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--reporter=json",
      "--outputFile=" + report,
    ]);
    const exitCode = run(
      runtime,
      "node",
      ["--import", "tsx", "scripts/ci-run-node-test-shard.mts"],
      group === "state" ? 1200 : 600,
    );
    const observation = classify(
      plan,
      JSON.parse(fs.readFileSync(report, "utf8")),
      exitCode,
      runtime,
    );
    summary.observations.push({ runtime, ...observation });
    save();
  }
  summary.outcome = summary.observations.some((value) => value.outcome === "failed")
    ? "test-failure"
    : "not-reproduced";
  process.exitCode = summary.outcome === "test-failure" ? 1 : 0;
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  save();
  console.log(JSON.stringify(summary));
  fs.rmSync(isolated, { recursive: true, force: true });
}
