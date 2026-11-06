// Temporary, nonpublishing comparison of existing Gradle dependency/task caches.
// Cache restore/save belongs to the workflow; this script never exports bundles.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const scriptStartedAt = new Date().toISOString();
const scriptStarted = performance.now();
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "source-sha": { type: "string" },
    plan: { type: "string" },
    variant: { type: "string" },
    "window-start": { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "--source <checkout> --source-sha <commit> --plan <saved-android-plan.json> " +
      "--variant cold|dependencies|tasks --window-start <window-start.json> --output <empty-directory>\n" +
      'Linux execution only. window-start.json contains {"startedAt":"<ISO timestamp>"} ' +
      "recorded before cache restore. dependencies/tasks require EXISTING_GRADLE_CACHE_HIT=true.",
  );
  process.exit(0);
}
assert.equal(process.platform, "linux", "Run on a fresh Linux CI runner.");
for (const option of ["source", "source-sha", "plan", "variant", "window-start", "output"]) {
  assert.ok(values[option], `Missing --${option}`);
}
const source = path.resolve(values.source);
const android = path.join(source, "apps/android");
const output = path.resolve(values.output);
fs.mkdirSync(output, { recursive: true });
assert.deepEqual(fs.readdirSync(output), [], "--output must be empty.");

const result = {
  variant: values.variant,
  sourceSha: values["source-sha"],
  scriptStartedAt,
  cacheHit: process.env.EXISTING_GRADLE_CACHE_HIT ?? null,
  stages: {},
  status: "failed",
  measuredSeconds: null,
  buildWindowSeconds: null,
  cleanupErrors: [],
};
const samples = [];
let sampler;
let windowStarted;
let signingDirectory;
let buildEnv;
let gradleStarted = false;
let failure;

function readOptional(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    // Runner kernels expose different cgroup/PSI files; unavailable is not zero.
    return null;
  }
}

function processStats() {
  const processes = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const raw = readOptional(`/proc/${entry}/stat`);
    if (!raw) {
      continue;
    }
    const closing = raw.lastIndexOf(")");
    const name = raw.slice(raw.indexOf("(") + 1, closing);
    // Node's process name varies; always include the benchmark's explicit PID.
    if (Number(entry) !== process.pid && name !== "java") {
      continue;
    }
    const fields = raw.slice(closing + 2).split(" ");
    processes.push({
      pid: Number(entry),
      name,
      benchmark: Number(entry) === process.pid,
      parentPid: Number(fields[1]),
      userTicks: Number(fields[11]),
      systemTicks: Number(fields[12]),
      startTicks: Number(fields[19]),
      rssPages: Number(fields[21]),
    });
  }
  return processes;
}

function resources() {
  return {
    at: new Date().toISOString(),
    cpu: readOptional("/proc/stat")?.split("\n")[0] ?? null,
    memory: readOptional("/proc/meminfo"),
    processes: processStats(),
    cpuPressure: readOptional("/proc/pressure/cpu"),
    memoryPressure: readOptional("/proc/pressure/memory"),
    ioPressure: readOptional("/proc/pressure/io"),
    cgroupCpu: readOptional("/sys/fs/cgroup/cpu.stat"),
    cgroupMemory: readOptional("/sys/fs/cgroup/memory.current"),
    memoryEvents: readOptional("/sys/fs/cgroup/memory.events"),
  };
}

async function run(name, command, args, cwd, env) {
  const started = performance.now();
  const stage = { startedAt: new Date().toISOString(), command, args };
  result.stages[name] = stage;
  try {
    const fd = fs.openSync(path.join(output, `${name}.log`), "wx", 0o600);
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    await new Promise((resolve) => {
      child.once("error", (error) => {
        stage.error = error.message;
      });
      child.once("close", (code, signal) => {
        Object.assign(stage, { code, signal });
        resolve();
      });
    });
  } finally {
    stage.completedAt = new Date().toISOString();
    stage.seconds = (performance.now() - started) / 1000;
    stage.code ??= null;
    console.log(JSON.stringify({ name, ...stage }));
  }
  assert.equal(stage.code, 0, `${name} failed; inspect ${name}.log.`);
}

const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();

try {
  assert.ok(["cold", "dependencies", "tasks"].includes(values.variant), "Invalid --variant.");
  assert.equal(values["source-sha"], "ba3392580165f2593b9d061aa90607517694ba53");
  const window = JSON.parse(fs.readFileSync(path.resolve(values["window-start"]), "utf8"));
  windowStarted = Date.parse(window.startedAt);
  assert.ok(Number.isFinite(windowStarted), "window-start.json needs a valid startedAt timestamp.");
  assert.ok(windowStarted <= Date.parse(scriptStartedAt), "Window must start before this script.");
  result.windowStartedAt = new Date(windowStarted).toISOString();
  for (const key of [
    "GOOGLE_PLAY_JSON_KEY_DATA",
    "GOOGLE_PLAY_JSON_KEY",
    "FIREBASE_APP_DISTRIBUTION_JSON_KEY_DATA",
    "MATCH_PASSWORD",
    "OPENAI_API_KEY",
  ]) {
    assert.ok(!Object.hasOwn(process.env, key), `Credential must be absent: ${key}`);
  }
  if (values.variant === "cold") {
    assert.ok(!process.env.EXISTING_GRADLE_CACHE_HIT, "Cold sample cannot restore a cache.");
  } else {
    assert.equal(process.env.EXISTING_GRADLE_CACHE_HIT, "true", "Existing cache must hit exactly.");
  }
  assert.equal(git("rev-parse", "HEAD"), values["source-sha"]);
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
  const plan = JSON.parse(fs.readFileSync(path.resolve(values.plan), "utf8"));
  result.originalPlan = plan;
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.sourceSha, "872da7a4fa7a72e7759eab87cd0adb31dd159b90");
  assert.match(plan.version, /^\d{4}\.\d{1,2}\.\d+$/);
  for (const code of [plan.versionCode, plan.wearVersionCode]) {
    assert.ok(Number.isSafeInteger(code) && code > 0 && code <= 2_100_000_000);
  }
  assert.equal(plan.wearVersionCode, plan.versionCode + 1);
  const parts = plan.version.split(".");
  parts[2] = String(Number(parts[2]) + 1);
  const identity = {
    sourceSha: values["source-sha"],
    version: parts.join("."),
    versionCode: plan.versionCode + 2,
    wearVersionCode: plan.wearVersionCode + 2,
    buildTimestamp: "2026-11-07T15:00:00.000Z",
  };
  assert.equal(identity.version, "2026.11.11");
  assert.equal(identity.versionCode, 2026090546);
  assert.equal(identity.wearVersionCode, 2026090547);
  result.identity = identity;

  assert.ok(process.env.HOME, "HOME is required.");
  assert.ok(process.env.RUNNER_TEMP, "RUNNER_TEMP is required.");
  const gradleHome = path.join(process.env.HOME, ".gradle");
  if (process.env.GRADLE_USER_HOME) {
    assert.equal(path.resolve(process.env.GRADLE_USER_HOME), gradleHome);
  }
  // Only caches/wrapper are restored on the fresh task-owned runner. Refuse an
  // existing daemon so the same-home/version --stop below can affect only us.
  const initialDaemons = processStats().filter(
    ({ pid, name }) =>
      name === "java" && readOptional(`/proc/${pid}/cmdline`)?.includes("GradleDaemon"),
  );
  assert.deepEqual(initialDaemons, [], "A fresh runner must have no existing Gradle daemon.");
  result.gradleUserHome = gradleHome;
  result.host = {
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus(),
    availableParallelism: os.availableParallelism(),
    memoryBytes: os.totalmem(),
    processStatus: readOptional(`/proc/${process.pid}/status`),
    cpuMax: readOptional("/sys/fs/cgroup/cpu.max"),
    cpuset: readOptional("/sys/fs/cgroup/cpuset.cpus.effective"),
    memoryMax: readOptional("/sys/fs/cgroup/memory.max"),
    clockTicks: execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim(),
    pageBytes: execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim(),
  };
  samples.push(resources());
  sampler = setInterval(() => samples.push(resources()), 1000);
  signingDirectory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "android-cache-signing-"));
  const signing = path.join(signingDirectory, "disposable.jks");
  await run(
    "signing",
    "keytool",
    [
      "-genkeypair",
      "-noprompt",
      "-storetype",
      "JKS",
      "-keystore",
      signing,
      "-storepass",
      "benchmark-only",
      "-keypass",
      "benchmark-only",
      "-alias",
      "benchmark",
      "-dname",
      "CN=Disposable benchmark",
      "-keyalg",
      "RSA",
      "-keysize",
      "2048",
      "-validity",
      "2",
    ],
    android,
    process.env,
  );
  buildEnv = {
    ...process.env,
    GRADLE_USER_HOME: gradleHome,
    ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_STORE_FILE: signing,
    ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_STORE_PASSWORD: "benchmark-only",
    ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_KEY_ALIAS: "benchmark",
    ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_KEY_PASSWORD: "benchmark-only",
  };
  const metadata = [
    `-PopenclawBuildCommit=${identity.sourceSha}`,
    `-PopenclawBuildTimestamp=${identity.buildTimestamp}`,
    `-POPENCLAW_ANDROID_VERSION_NAME=${identity.version}`,
    `-POPENCLAW_ANDROID_VERSION_CODE=${identity.versionCode}`,
    `-POPENCLAW_ANDROID_WEAR_VERSION_CODE=${identity.wearVersionCode}`,
  ];
  const flags = [
    "--profile",
    "--info",
    values.variant === "tasks" ? "--build-cache" : "--no-build-cache",
  ];
  result.gradleFlags = flags;
  gradleStarted = true;
  await run(
    "preflight",
    "./gradlew",
    [...metadata, ":app:validateSigningPlayRelease", ":wear:validateSigningRelease", ...flags],
    android,
    buildEnv,
  );
  await run(
    "build",
    "./gradlew",
    [...metadata, ":wear:bundleRelease", ":app:bundlePlayRelease", ...flags],
    android,
    buildEnv,
  );
  for (const [name, artifact] of [
    ["verify-wear", "wear/build/outputs/bundle/release/wear-release.aab"],
    ["verify-phone", "app/build/outputs/bundle/playRelease/app-play-release.aab"],
  ]) {
    await run(
      name,
      "jarsigner",
      ["-J-Duser.language=en", "-J-Duser.country=US", "-verify", path.join(android, artifact)],
      android,
      buildEnv,
    );
    assert.match(fs.readFileSync(path.join(output, `${name}.log`), "utf8"), /jar verified\./);
  }
  const checkStarted = performance.now();
  const check = { startedAt: new Date().toISOString(), code: null };
  result.stages["source-check"] = check;
  try {
    assert.equal(git("rev-parse", "HEAD"), values["source-sha"]);
    assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
    check.code = 0;
  } finally {
    check.completedAt = new Date().toISOString();
    check.seconds = (performance.now() - checkStarted) / 1000;
    check.code ??= 1;
  }
  result.status = "passed";
} catch (error) {
  failure = error;
  result.error = error.stack ?? String(error);
} finally {
  // End the measured window after signature/source checks, before daemon cleanup
  // or the workflow's optional, separately timed one-off cache save.
  result.windowCompletedAt = new Date().toISOString();
  result.measuredSeconds = windowStarted === undefined ? null : (Date.now() - windowStarted) / 1000;
  result.buildWindowSeconds = (performance.now() - scriptStarted) / 1000;
  const cleanupStarted = performance.now();
  result.cleanupStartedAt = new Date().toISOString();
  clearInterval(sampler);
  samples.push(resources());
  const cleanup = async (name, operation) => {
    try {
      await operation();
    } catch (error) {
      result.cleanupErrors.push({ name, error: error.message });
      failure ??= error;
      result.status = "failed";
    }
  };
  if (gradleStarted) {
    await cleanup("stop-daemon", () =>
      run("stop-daemon", "./gradlew", ["--stop"], android, buildEnv),
    );
  }
  if (signingDirectory) {
    await cleanup("remove-signing", () =>
      fs.rmSync(signingDirectory, { recursive: true, force: true }),
    );
  }
  await cleanup("profiles", () => {
    const profiles = path.join(android, "build/reports/profile");
    if (fs.existsSync(profiles)) {
      fs.cpSync(profiles, path.join(output, "gradle-profile"), { recursive: true });
    }
  });
  await cleanup("resources", () => {
    fs.writeFileSync(path.join(output, "resources.json"), JSON.stringify(samples));
  });
  result.cleanupCompletedAt = new Date().toISOString();
  result.cleanupSeconds = (performance.now() - cleanupStarted) / 1000;
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      variant: result.variant,
      status: result.status,
      measuredSeconds: result.measuredSeconds,
    }),
  );
}
if (failure) {
  console.error(failure.message);
  process.exitCode = 1;
}
