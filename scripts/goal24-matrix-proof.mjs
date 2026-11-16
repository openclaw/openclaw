// Fixed causal proof; execute contributor modules only on a disposable hosted VM.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const candidate = "bf8ee2c6152a18386a175ad329013bc20a4a8051";
export const baseline = "937f77cb20ded2e041f5ea876200d01b449d0329";
export const wireName = "classifies a real SDK forbidden send conservatively after redirect=";
export const ownerName =
  "preserves earlier delivery uncertainty when a later attempt is rejected: ";
export function admit(report, exitCode, kind, original = false) {
  const cases = report.testResults
    .flatMap((suite) => suite.assertionResults)
    .filter((test) => ["passed", "failed"].includes(test.status));
  assert.ok(cases.length > 0, "zero executed cases");
  const stem = kind === "wire" ? wireName : kind === "owner" ? ownerName : null;
  if (stem) {
    assert.equal(
      new Set(cases.map((test) => test.fullName)).size,
      cases.length,
      "duplicate causal cases",
    );
    assert.equal(cases.length, 2, "partial or extra causal cases");
    for (const flag of [false, true]) {
      const test = cases.find((entry) => entry.fullName.endsWith(stem + flag));
      assert.ok(test, "missing required causal case");
      const failed = original && ((kind === "wire" && !flag) || (kind === "owner" && flag));
      assert.equal(test.status, failed ? "failed" : "passed", "unexpected causal outcome");
      if (failed) {
        const errors = test.failureMessages.join("\n");
        assert.match(
          errors,
          kind === "wire"
            ? /MatrixError: \[403\] Cannot send to room/
            : /MatrixError: \[403\] M_FORBIDDEN/,
        );
        assert.doesNotMatch(errors, /Cannot find|Failed to load|timed out|Timeout|ECONNREFUSED/i);
      }
    }
  } else {
    assert.equal(
      cases.length,
      { sdk: 97, transport: 16, authority: 14 }[kind],
      "incomplete pinned suite",
    );
    assert.ok(cases.every((test) => test.status === "passed"));
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
  const isolated = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "goal24-matrix-"));
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
  const test = (name, file, kind, filter, old = false) => {
    const report = path.join(output, name + ".json");
    const args = [
      "scripts/run-vitest.mjs",
      file,
      "--maxWorkers=1",
      "--reporter=json",
      "--outputFile=" + report,
    ];
    if (filter) {
      args.push("-t", filter);
    }
    const code = run(name, "node", args, 600);
    summary.stages.at(-1).cases = admit(
      JSON.parse(fs.readFileSync(report, "utf8")),
      code,
      kind,
      old,
    );
    save();
  };
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
    const matrix = "extensions/matrix/src/matrix/";
    // Run 43790032640 executed all 97 SDK cases successfully (71.404 s wrapper).
    // Only their legitimate repeated parameterized title tripped the old gate.
    // The retained JSON was admitted locally with this corrected gate; do not rerun.
    summary.retainedSdk = {
      runId: 43790032640,
      jobId: 133046118335,
      tooling: "a95800834f9353eb801eebff4a8b274ecb9f1d99",
      passed: 97,
      durationMs: 71404,
    };
    test("candidate-transport", matrix + "sdk/transport.test.ts", "transport");
    test(
      "candidate-authority",
      matrix + "sdk/transport.authority-integration.test.ts",
      "authority",
    );
    const ownerFile = "src/agents/tools/message-tool-execution.test.ts";
    test("candidate-owner", ownerFile, "owner", ownerName);
    // Original modules in otherwise identical candidate dependencies/tests.
    // This is an original-module differential, NOT a full baseline checkout run.
    for (const file of [
      matrix + "sdk/client-core.ts",
      matrix + "sdk/message-wire-dispatch.ts",
      "src/infra/outbound/message-action-execution.ts",
    ]) {
      const before = fs.readFileSync(path.join(original, file));
      const after = fs.readFileSync(path.join(source, file));
      assert.notEqual(hash(before), hash(after));
      summary.modules.push({ file, baselineHash: hash(before), candidateHash: hash(after) });
      fs.writeFileSync(path.join(source, file), before);
    }
    summary.testHashes = [matrix + "sdk/transport.test.ts", ownerFile].map((file) => ({
      file,
      sha256: hash(fs.readFileSync(path.join(source, file))),
    }));
    save();
    // New process-local compiler cache after changing the original modules.
    env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH = path.join(isolated, "original-cache");
    fs.mkdirSync(env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH);
    test("original-wire", matrix + "sdk/transport.test.ts", "wire", wireName, true);
    test("original-owner", ownerFile, "owner", ownerName, true);
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
