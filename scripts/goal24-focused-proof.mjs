// Fixed, temporary Goal 24 proof orchestration. Run only on disposable hosted runners.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const targets = {
  history: "eb919fb0d0b19dfa86c3e7055145b5a83ae27ef9",
  permissions:
    process.env.GOAL24_PERMISSION_VARIANT === "baseline"
      ? "2f4ae4d3284bf17ad4930cf6770dac14c025bfc1"
      : "77ee3e8424d789b7bad5804a9dc5a1693f34c91e",
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
    const prefix = vitest("prefix-stability", "src/agents/agent-tools.prefix-stability.test.ts");
    assert.equal(prefix.executed.length, 14, "the pinned prefix suite must execute all 14 cases");
    assert.ok(
      prefix.executed.some((test) =>
        test.fullName.includes(
          "offers the session's tool definitions and refuses tools outside the replayed authority",
        ),
      ),
      "missing completion-handoff prefix regression",
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
    const baselineSha = "e80a6dd9fdb4c7ce724472dd5d1b216afb4e70a7";
    const baseline = path.join(root, "baseline");
    assert.equal(
      spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: baseline,
        env,
        encoding: "utf8",
      }).stdout.trim(),
      baselineSha,
    );
    const baselineModule = fs.readFileSync(path.join(baseline, "src/media/audio-transcode.ts"));
    assert.equal(
      createHash("sha256").update(baselineModule).digest("hex"),
      "867e5fd7ad1b477b1f4ab1023e15d440873c6f9d3d98253bfa6ac4240f6b370d",
    );
    fs.writeFileSync(path.join(source, "src/media/goal24-audio-baseline.ts"), baselineModule);
    fs.copyFileSync(
      path.join(root, "tooling/scripts/goal24-audio-native-proof.mts"),
      path.join(source, "scripts/goal24-audio-native-proof.mts"),
    );
    const receipts = [];
    for (const variant of ["baseline", "fixed"]) {
      env.GOAL24_AUDIO_CASE = variant;
      const name = "audio-native-" + variant;
      const status = run(
        name,
        "node",
        ["--import", "tsx", "scripts/goal24-audio-native-proof.mts"],
        120000,
        variant === "baseline",
      );
      const records = fs
        .readFileSync(path.join(output, name + ".log"), "utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        })
        .filter((record) => record.proof === "goal24-audio-native");
      assert.equal(records.length, 1, "exactly one native case receipt required");
      const native = records[0];
      assert.equal(native.variant, variant);
      assert.equal(native.audioSha, targets.audio);
      assert.equal(native.expectedFrames, 1_153_775);
      assert.equal(native.cleanupVerified, true);
      if (variant === "baseline") {
        assert.equal(status, 1, "original converter must fail the preservation assertion");
        assert.equal(native.ok, false);
        assert.equal(native.stage, "frame-preservation");
        assert.ok(
          native.actualFrames > 0 && native.actualFrames < native.expectedFrames / 2,
          "baseline must exhibit substantial native truncation",
        );
      } else {
        assert.equal(native.ok, true);
        assert.equal(native.segments?.length, 10, "all ten segment signals required");
      }
      receipts.push(native);
    }
    delete env.GOAL24_AUDIO_CASE;
    summary.native = receipts;
  } else {
    assert.equal(process.platform, "darwin");
    summary.outcome = "setup-failure";
    summary.macos = capture("sw_vers", ["-productVersion"]);
    summary.xcode = capture("xcodebuild", ["-version"]);
    summary.swift = capture("swift", ["--version"]);
    const swiftVersion = summary.swift.match(/Swift version (\d+)\.(\d+)/);
    assert.ok(swiftVersion, "Swift must report its compiler version");
    assert.ok(
      Number(swiftVersion[1]) > 6 ||
        (Number(swiftVersion[1]) === 6 && Number(swiftVersion[2]) >= 3),
      "Swift 6.3 or newer is required by the pinned Package.swift",
    );
    const variant = process.env.GOAL24_PERMISSION_VARIANT;
    assert.ok(["candidate", "baseline"].includes(variant), "unknown permission variant");
    summary.permissionVariant = variant;
    summary.evidenceKind =
      "Same test transplanted into full baseline and candidate; Objective-C OS I/O interception; unchanged production code";
    const support = path.join(source, "apps/macos/Tests/OpenClawWebKitTestSupport");
    const fixtures = path.join(root, "tooling/scripts");
    const header = path.join(support, "include/OpenClawWebKitTestSupport.h");
    fs.appendFileSync(
      header,
      "\nBOOL Goal24InstallSpeechFixture(void);\nint Goal24SpeechRequestCount(void);\nvoid Goal24RestoreSpeechFixture(void);\n",
    );
    for (const [from, to] of [
      ["goal24-speech-fixture.m", path.join(support, "Goal24SpeechFixture.m")],
      [
        "goal24-speech-fixture.swift",
        path.join(
          source,
          "apps/macos/Tests/OpenClawIPCTests/Goal24SpeechFrameworkBoundaryTests.swift",
        ),
      ],
    ]) {
      const bytes = fs.readFileSync(path.join(fixtures, from));
      fs.writeFileSync(to, bytes);
      fs.writeFileSync(path.join(output, from), bytes);
      summary[from] = createHash("sha256").update(bytes).digest("hex");
    }
    assert.equal(
      capture("git", ["diff", "--", "apps/macos/Sources", "apps/macos/Package.swift"]),
      "",
      "production sources and build settings must remain unchanged",
    );
    fs.writeFileSync(
      path.join(output, "fixture-overlay.patch"),
      capture("git", ["diff", "--", "apps/macos/Tests"]) + "\n",
    );
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
    summary.outcome = "test-failure";
    const permissionExit = run(
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
        "Goal24SpeechFrameworkBoundaryTests.*offMainFrameworkCompletion",
        "--no-parallel",
      ],
      300000,
      variant === "baseline",
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
        JSON.stringify(record.payload).includes("offMainFrameworkCompletion"),
    );
    assert.equal(tests.length, 1, "exact PermissionManager regression not discovered");
    const id = tests[0].payload.id;
    const log = fs.readFileSync(path.join(output, "permissions-test.log"), "utf8");
    assert.equal(
      log.split("GOAL24_SPEECH_CALLBACK background=1 requests=1").length,
      2,
      "real framework boundary must invoke exactly one completion off the main thread",
    );
    summary.offMainCallback = true;
    const functionIds = new Set(
      records
        .filter((record) => record.kind === "test" && record.payload.kind === "function")
        .map((record) => record.payload.id),
    );
    const started = records.filter(
      (record) =>
        record.kind === "event" &&
        record.payload.kind === "testStarted" &&
        functionIds.has(record.payload.testID),
    );
    const ended = records.filter(
      (record) =>
        record.kind === "event" &&
        record.payload.kind === "testEnded" &&
        functionIds.has(record.payload.testID),
    );
    assert.equal(started.length, 1, "exactly one selected test must start");
    assert.equal(started[0].payload.testID, id);
    summary.permissionStarted = started.length;
    summary.permissionCompleted = ended.length;
    summary.permissionRegression = id;
    if (variant === "baseline") {
      if (permissionExit === 0) {
        summary.outcome = "control-not-reproduced";
      }
      assert.notEqual(permissionExit, 0, "baseline callback must fail");
      assert.equal(ended.length, 0, "baseline callback must trap before test completion");
      assert.match(
        log,
        /(?:Signal 4|signal code 4|SIGILL|SIGTRAP|Trace\/BPT trap)/i,
        "control must terminate with the native actor trap, not setup failure",
      );
      assert.match(
        log,
        /_dispatch_assert_queue_fail|swift_task_checkIsolated|swift_task_isCurrentExecutor/,
        "control must contain an executor isolation assertion",
      );
      assert.match(
        log,
        /PermissionManager.*ensureSpeechRecognition|ensureSpeechRecognition.*PermissionManager/,
        "control must identify the production permission callback in its crash stack",
      );
      summary.controlFailure = "native executor assertion at production speech callback entry";
    } else {
      assert.equal(ended.length, 1, "candidate must complete exactly one test");
      assert.equal(ended[0].payload.testID, id);
      assert.ok(
        records.some((record) => record.kind === "event" && record.payload.kind === "runEnded"),
      );
    }
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
