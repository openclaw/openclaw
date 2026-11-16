// Fixed original-module differential; product execution is hosted-only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const candidate = "1fab66039a51c51fe9c6585d2f9b7365461be252";
export const baseline = "976a4fb8784a326579108e03d0df4356dad501a3";
export const file = "src/auto-reply/reply/agent-runner-steer-adoption.worker.test.ts";
export const title = "preserves the active reply contract for ";
export function admit(report, exitCode, original = false) {
  const cases = report.testResults
    .flatMap((suite) => suite.assertionResults)
    .filter((test) => ["passed", "failed"].includes(test.status));
  assert.equal(cases.length, 4, "partial or extra steering cases");
  assert.equal(new Set(cases.map((test) => test.fullName)).size, 4, "duplicate steering cases");
  for (const scenario of [
    "optional-human",
    "required-human",
    "optional-room",
    "optional-internal",
  ]) {
    const entry = cases.find((test) => test.fullName.endsWith(title + scenario + " steering"));
    assert.ok(entry, "missing steering case");
    const failed = original && scenario === "optional-human";
    assert.equal(entry.status, failed ? "failed" : "passed", "unexpected steering outcome");
    if (failed) {
      const errors = entry.failureMessages.join("\n");
      assert.match(
        errors,
        /expected \[\] to deeply equal \[ 'oh wait, use the corrected requirements' \]/,
      );
      assert.match(errors, /agent-runner-steer-adoption\.worker\.test\.ts:99:\d+/);
      const diagnostics = errors
        .split("\n")
        .filter((line) => !/^\s+at\s/.test(line))
        .join("\n");
      assert.doesNotMatch(
        diagnostics,
        /Cannot find|Failed to load|timed out|Timeout|ECONNREFUSED/i,
      );
    }
  }
  assert.equal(exitCode, original ? 1 : 0, "unexpected launcher exit");
  return cases.map(({ fullName, status, failureMessages }) => ({
    fullName,
    status,
    failureMessages,
  }));
}

function main() {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.platform, "linux");
  const root = process.cwd();
  const source = path.join(root, "source");
  const original = path.join(root, "baseline");
  const output = path.join(root, "proof-output");
  fs.mkdirSync(output, { recursive: true });
  const isolated = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "goal24-steering-"));
  const env = Object.fromEntries(
    ["PATH", "PNPM_HOME", "COREPACK_HOME"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  for (const name of ["home", "tmp", "state", "cache"]) {
    fs.mkdirSync(path.join(isolated, name));
  }
  Object.assign(env, {
    HOME: path.join(isolated, "home"),
    TMPDIR: path.join(isolated, "tmp"),
    OPENCLAW_STATE_DIR: path.join(isolated, "state"),
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(isolated, "cache"),
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    RUNNER_TEMP: isolated,
    LANG: "en_US.UTF-8",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
  });
  const summary = {
    candidate,
    baseline,
    tooling: process.env.GITHUB_SHA,
    node: process.version,
    outcome: "setup-failure",
    stages: [],
    modules: [],
  };
  const save = () =>
    fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const capture = (args, cwd) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0);
    return result.stdout.trim();
  };
  const run = (name, command, args, seconds) => {
    const fd = fs.openSync(path.join(output, name + ".log"), "w", 0o600);
    const start = Date.now();
    const result = spawnSync(
      "timeout",
      ["--signal=TERM", "--kill-after=15s", String(seconds) + "s", command, ...args],
      {
        cwd: source,
        env,
        stdio: ["ignore", fd, fd],
        timeout: (seconds + 30) * 1000,
        killSignal: "SIGKILL",
      },
    );
    fs.closeSync(fd);
    summary.stages.push({
      name,
      command,
      args,
      durationMs: Date.now() - start,
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
    });
    save();
    assert.ok(
      !result.error && !result.signal && ![124, 137].includes(result.status),
      "incomplete command",
    );
    return result.status;
  };
  const test = (name, testFile, filter, old = false) => {
    const report = path.join(output, name + ".json");
    const args = [
      "scripts/run-vitest.mjs",
      testFile,
      "--maxWorkers=1",
      "--reporter=json",
      "--outputFile=" + report,
    ];
    if (filter) {
      args.push("-t", filter);
    }
    const code = run(name, "node", args, 600);
    summary.stages.at(-1).cases = admit(JSON.parse(fs.readFileSync(report, "utf8")), code, old);
    save();
  };
  try {
    assert.equal(process.version, "v24.22.1");
    for (const [cwd, sha] of [
      [source, candidate],
      [original, baseline],
    ]) {
      assert.equal(capture(["rev-parse", "HEAD"], cwd), sha);
      assert.equal(capture(["status", "--porcelain"], cwd), "");
      assert.equal(
        spawnSync("git", ["config", "--local", "--get-regexp", "http.*extraheader"], { cwd, env })
          .status,
        1,
        "retained checkout credential",
      );
    }
    assert.equal(run("install", "pnpm", ["install", "--frozen-lockfile"], 900), 0);
    summary.outcome = "test-failure";
    const module = "src/auto-reply/reply/agent-runner-steer-adoption.ts";
    const before = fs.readFileSync(path.join(original, module));
    const after = fs.readFileSync(path.join(source, module));
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.notEqual(hash(before), hash(after));
    summary.modules.push({ file: module, baselineHash: hash(before), candidateHash: hash(after) });
    summary.testHash = hash(fs.readFileSync(path.join(source, file)));
    save();
    test("candidate-steering", file, title);
    fs.writeFileSync(path.join(source, module), before);
    env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH = path.join(isolated, "original-cache");
    fs.mkdirSync(env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH);
    assert.equal(hash(fs.readFileSync(path.join(source, file))), summary.testHash);
    test("original-steering", file, title, true);
    summary.outcome = "causal-original-module-red-candidate-green";
  } catch (error) {
    summary.error = String(error.stack ?? error);
    process.exitCode = 1;
  } finally {
    save();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main();
}
