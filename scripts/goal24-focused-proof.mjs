// Fixed, temporary Goal 24 proof orchestration. Run only on disposable hosted runners.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const targets = {
  history: "eb919fb0d0b19dfa86c3e7055145b5a83ae27ef9",
  permissions: "77ee3e8424d789b7bad5804a9dc5a1693f34c91e",
  audio: "a9a084486e3df10193dfa9ac5ab9faa9f53a4619",
};
const proof = process.env.GOAL24_PROOF;
assert.ok(Object.hasOwn(targets, proof), "unknown fixed proof");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const root = process.cwd();
const source = path.join(root, "source");
const output = path.join(root, "proof-output");
const isolated = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "goal24-"));
fs.mkdirSync(output, { recursive: true });
for (const directory of ["home", "tmp", "state", "cache"]) {
  fs.mkdirSync(path.join(isolated, directory));
}
// Do not pass Actions service tokens, Git credentials, or the operator environment
// to dependency lifecycle scripts or contributor code. The hosted VM is disposable.
const env = Object.fromEntries(
  ["PATH", "DEVELOPER_DIR", "SDKROOT", "SYSTEMROOT", "PNPM_HOME", "COREPACK_HOME"].flatMap((key) =>
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
  CI: "true",
  GITHUB_ACTIONS: "true",
  RUNNER_OS: process.env.RUNNER_OS,
  RUNNER_TEMP: isolated,
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
});
const summary = {
  proof,
  sourceSha: targets[proof],
  toolingSha: process.env.GITHUB_SHA,
  runUrl:
    "https://github.com/" +
    process.env.GITHUB_REPOSITORY +
    "/actions/runs/" +
    process.env.GITHUB_RUN_ID,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  stages: [],
  outcome: "setup-failure",
};
function save() {
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
}
function run(name, command, args, timeout, expectedFailure = false) {
  const log = fs.openSync(path.join(output, name + ".log"), "w", 0o600);
  const start = Date.now();
  const result = spawnSync(command, args, {
    cwd: source,
    env,
    timeout,
    killSignal: "SIGKILL",
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
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
  assert.ok(!result.error && !result.signal, name + " failed to complete");
  if (!expectedFailure) {
    assert.equal(result.status, 0, name + " failed; see artifact log");
  }
  return result.status;
}
function capture(command, args) {
  const result = spawnSync(command, args, { cwd: source, env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, command + " preflight failed");
  return result.stdout.trim();
}
function vitest(name, file, filter, expectedFailure = false) {
  const report = path.join(output, name + ".json");
  const args = ["test", file, "--maxWorkers=1", "--reporter=json", "--outputFile=" + report];
  if (filter) {
    args.push("-t", filter);
  }
  const exitCode = run(name, "pnpm", args, 600000, expectedFailure);
  const result = JSON.parse(fs.readFileSync(report, "utf8"));
  const assertions = result.testResults.flatMap((suite) => suite.assertionResults);
  const executed = assertions.filter((test) => ["passed", "failed"].includes(test.status));
  assert.ok(executed.length > 0, name + " selected zero tests");
  summary.stages.at(-1).tests = executed.map(({ fullName, status, failureMessages }) => ({
    fullName,
    status,
    failureMessages,
  }));
  save();
  if (!expectedFailure) {
    assert.ok(executed.every((test) => test.status === "passed"));
  }
  return { status: exitCode, executed };
}
try {
  assert.equal(capture("git", ["rev-parse", "HEAD"]), targets[proof]);
  assert.equal(capture("git", ["status", "--porcelain"]), "");
  const credentials = spawnSync("git", ["config", "--local", "--get-regexp", "http.*extraheader"], {
    cwd: source,
    env,
  });
  assert.equal(credentials.status, 1, "checkout retained credentials");
  summary.pnpm = capture("pnpm", ["--version"]);
  summary.outcome = "setup-failure";
  run("install", "pnpm", ["install", "--frozen-lockfile"], 900000);
  summary.outcome = "test-failure";
  if (proof === "history") {
    const recent = vitest("recent-text", "src/config/sessions/transcript-recent-text.test.ts");
    const inbound = vitest(
      "inbound-context",
      "src/channels/inbound-event/session-transcript-context.sqlite.test.ts",
    );
    for (const required of [
      "bounds candidate coverage in physical rows",
      "does not bridge an oversized user barrier",
      "shares the 64 MiB candidate budget",
    ]) {
      assert.ok(
        recent.executed.some((test) => test.fullName.includes(required)),
        "missing regression: " + required,
      );
    }
    assert.ok(
      inbound.executed.some((test) =>
        test.fullName.includes(
          "suppresses already-replayed DM turns while preserving delivery-only context after restart",
        ),
      ),
    );
  } else if (proof === "audio") {
    assert.equal(process.platform, "darwin");
    const filter = "shares one budget across decode, encode and probe";
    const fixed = vitest("audio-budget", "src/media/audio-transcode.test.ts", filter);
    assert.equal(fixed.executed.length, 2);
    const target = path.join(source, "src/media/audio-transcode.ts");
    const original = fs.readFileSync(target, "utf8");
    const before = "const ms = Math.floor(deadline - performance.now());";
    const after = "const ms = params.timeoutMs ?? 5000;";
    assert.equal(original.split(before).length, 2, "mutation must match exactly once");
    fs.writeFileSync(target, original.replace(before, after));
    const patch = capture("git", ["diff", "--", "src/media/audio-transcode.ts"]);
    fs.writeFileSync(path.join(output, "mutation.patch"), patch + "\n");
    summary.mutationSha256 = createHash("sha256").update(patch).digest("hex");
    try {
      const mutant = vitest(
        "audio-budget-mutant",
        "src/media/audio-transcode.test.ts",
        filter,
        true,
      );
      assert.notEqual(mutant.status, 0, "timeout-removal mutant survived");
      assert.equal(mutant.executed.length, 2);
      assert.ok(
        mutant.executed.some(
          (test) =>
            test.status === "failed" &&
            test.failureMessages.some(
              (message) =>
                message.includes("to deeply equal") &&
                message.includes("5000") &&
                message.includes("2000"),
            ),
        ),
        "mutation failed for something other than the budget assertion",
      );
    } finally {
      fs.writeFileSync(target, original);
    }
    fs.copyFileSync(
      path.join(root, "tooling/scripts/goal24-audio-native-proof.mts"),
      path.join(source, "scripts/goal24-audio-native-proof.mts"),
    );
    run(
      "audio-native",
      "node",
      ["--import", "tsx", "scripts/goal24-audio-native-proof.mts"],
      120000,
    );
    const records = fs
      .readFileSync(path.join(output, "audio-native.log"), "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const native = records.find((record) => record.proof === "goal24-audio-native");
    assert.equal(native?.ok, true, "native harness did not produce a passing receipt");
    summary.native = native;
  } else {
    assert.equal(process.platform, "darwin");
    summary.macos = capture("sw_vers", ["-productVersion"]);
    summary.xcode = capture("xcodebuild", ["-version"]);
    summary.swift = capture("swift", ["--version"]);
    assert.match(summary.swift, /Swift version 6\.3/);
    run("native-assets", "node", ["scripts/prepare-apple-mermaid.mjs"], 300000);
    run(
      "swift-build",
      "swift",
      [
        "build",
        "--package-path",
        "apps/macos",
        "--build-system",
        "native",
        "--enable-code-coverage",
        "--disable-index-store",
        "-Xswiftc",
        "-gline-tables-only",
        "--build-tests",
      ],
      1800000,
    );
    // The canonical launcher owns test HOME/keychain isolation and removes its
    // scratch event stream. This shim only preserves that stream after Swift exits.
    const swift = capture("/usr/bin/which", ["swift"]);
    const shims = path.join(isolated, "shims");
    fs.mkdirSync(shims);
    const events = path.join(output, "swift-events.jsonl");
    fs.writeFileSync(
      path.join(shims, "swift"),
      "#!/usr/bin/env node\n" +
        "const{spawnSync}=require('node:child_process');const fs=require('node:fs');const a=process.argv.slice(2);" +
        "const r=spawnSync(" +
        JSON.stringify(swift) +
        ",a,{stdio:'inherit',timeout:290000,killSignal:'SIGKILL'});" +
        "const p=a[a.indexOf('--event-stream-output-path')+1];if(p&&fs.existsSync(p))fs.copyFileSync(p," +
        JSON.stringify(events) +
        ");process.exit(r.status??1);\n",
      { mode: 0o700 },
    );
    env.PATH = shims + path.delimiter + env.PATH;
    run(
      "permissions-test",
      "node",
      [
        "scripts/test-macos-native.mts",
        "default",
        "--package-path",
        "apps/macos",
        "--build-system",
        "native",
        "--disable-index-store",
        "-Xswiftc",
        "-gline-tables-only",
        "--skip-build",
        "--filter",
        "PermissionManagerTests",
        "--no-parallel",
      ],
      300000,
    );
    const records = fs
      .readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const tests = records.filter(
      (record) =>
        record.kind === "test" &&
        record.payload.kind === "function" &&
        JSON.stringify(record.payload).includes(
          "speech authorization completion can enter from a background queue",
        ),
    );
    assert.equal(tests.length, 1, "exact PermissionManager regression not discovered");
    const id = tests[0].payload.id;
    for (const kind of ["testStarted", "testEnded"]) {
      assert.ok(
        records.some(
          (record) =>
            record.kind === "event" && record.payload.kind === kind && record.payload.testID === id,
        ),
        "regression did not " + kind,
      );
    }
    summary.permissionRegression = id;
  }
  summary.outcome = "pass";
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  save();
  console.log(JSON.stringify(summary));
  fs.rmSync(isolated, { recursive: true, force: true });
}
