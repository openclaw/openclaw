// Temporary archive-only experiment: the actual notes owner and phone/Wear Gradle
// tasks, twice per variant on fresh 8-class runners. No publishing owner is called.
// Compare complete notes+bundle elapsed time after identical signing preflight;
// overlap wins only if both paired windows improve without a build failure.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    plan: { type: "string" },
    variant: { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "--source <checkout> --plan <saved-plan> --variant serial|overlap --output <directory>",
  );
  process.exit(0);
}
assert.equal(process.platform, "linux", "Run on a fresh Linux CI runner.");
assert.ok(["serial", "overlap"].includes(values.variant));
for (const option of ["source", "plan", "output"]) {
  assert.ok(values[option], `Missing --${option}`);
}
const source = path.resolve(values.source);
const planPath = path.resolve(values.plan);
const output = path.resolve(values.output);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const expectedSource = "872da7a4fa7a72e7759eab87cd0adb31dd159b90";
const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
assert.equal(plan.sourceSha, expectedSource);
assert.equal(git("rev-parse", "HEAD"), expectedSource);
assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
assert.ok(process.env.OPENAI_API_KEY, "The real release-note generator needs OPENAI_API_KEY.");
for (const key of [
  "GOOGLE_PLAY_JSON_KEY_DATA",
  "GOOGLE_PLAY_JSON_KEY",
  "FIREBASE_APP_DISTRIBUTION_JSON_KEY_DATA",
  "MATCH_PASSWORD",
]) {
  assert.ok(!process.env[key], `Publishing/signing credential must be absent: ${key}`);
}
fs.mkdirSync(output, { recursive: true });
const android = path.join(source, "apps/android");
const gradleHome = path.join(process.env.RUNNER_TEMP, "android-overlap-gradle");
assert.ok(!fs.existsSync(gradleHome), "Every sample needs a fresh Gradle user home.");
fs.mkdirSync(gradleHome);
const signing = path.join(process.env.RUNNER_TEMP, "android-overlap-disposable.jks");
execFileSync(
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
  { stdio: "ignore" },
);
const buildEnv = {
  ...process.env,
  GRADLE_USER_HOME: gradleHome,
  ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_STORE_FILE: signing,
  ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_STORE_PASSWORD: "benchmark-only",
  ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_KEY_ALIAS: "benchmark",
  ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_KEY_PASSWORD: "benchmark-only",
};
delete buildEnv.OPENAI_API_KEY;
const metadata = [
  `-PopenclawBuildCommit=${expectedSource}`,
  "-PopenclawBuildTimestamp=2026-11-06T19:45:06.000Z",
  `-POPENCLAW_ANDROID_VERSION_NAME=${plan.version}`,
  `-POPENCLAW_ANDROID_VERSION_CODE=${plan.versionCode}`,
  `-POPENCLAW_ANDROID_WEAR_VERSION_CODE=${plan.wearVersionCode}`,
];
const stages = {};
function run(name, command, args, cwd, env) {
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const fd = fs.openSync(path.join(output, `${name}.log`), "wx", 0o600);
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ name, error: error.message }));
    child.once("close", (code, signal) => {
      const result = {
        name,
        startedAt,
        completedAt: new Date().toISOString(),
        seconds: (performance.now() - start) / 1000,
        code,
        signal,
      };
      stages[name] = result;
      console.log(JSON.stringify({ stage: result }));
      resolve(result);
    });
  });
}
function readOptional(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") {
      return null;
    }
    throw error;
  }
}
function resources() {
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
    if (!["java", "node", "bun"].includes(name)) {
      continue;
    }
    const fields = raw.slice(closing + 2).split(" ");
    // /proc stat fields: remainder starts at state (3); utime=14, stime=15, RSS=24.
    processes.push({
      pid: Number(entry),
      name,
      userTicks: Number(fields[11]),
      systemTicks: Number(fields[12]),
      rssPages: Number(fields[21]),
    });
  }
  return {
    at: new Date().toISOString(),
    cpu: readOptional("/proc/stat")?.split("\n")[0],
    memory: readOptional("/proc/meminfo"),
    processes,
    cpuPressure: readOptional("/proc/pressure/cpu"),
    memoryPressure: readOptional("/proc/pressure/memory"),
    ioPressure: readOptional("/proc/pressure/io"),
    cgroupCpu: readOptional("/sys/fs/cgroup/cpu.stat"),
    cgroupMemory: readOptional("/sys/fs/cgroup/memory.current"),
  };
}
const host = {
  platform: process.platform,
  arch: process.arch,
  cpus: os.cpus(),
  memoryBytes: os.totalmem(),
  cpuMax: readOptional("/sys/fs/cgroup/cpu.max"),
  cpuset: readOptional("/sys/fs/cgroup/cpuset.cpus.effective"),
  memoryMax: readOptional("/sys/fs/cgroup/memory.max"),
  clockTicks: execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim(),
  pageBytes: execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim(),
};
const samples = [];
let sampler;
let measuredStart;
try {
  const preflight = await run(
    "preflight",
    "./gradlew",
    [...metadata, ":app:validateSigningPlayRelease", ":wear:validateSigningRelease", "--profile"],
    android,
    buildEnv,
  );
  assert.equal(preflight.code, 0, "Signing preflight failed; inspect preflight.log.");
  samples.push(resources());
  sampler = setInterval(() => samples.push(resources()), 1000);
  measuredStart = performance.now();
  const notes = () =>
    run(
      "notes",
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/mobile-release-notes.ts",
        "generate",
        "--platform",
        "android",
        "--plan",
        planPath,
        "--output",
        path.join(output, "release-notes.json"),
      ],
      source,
      process.env,
    );
  const build = () =>
    run(
      "build",
      "./gradlew",
      [...metadata, ":wear:bundleRelease", ":app:bundlePlayRelease", "--profile"],
      android,
      buildEnv,
    );
  const results =
    values.variant === "serial"
      ? [await notes(), await build()]
      : await Promise.all([notes(), build()]);
  for (const result of results) {
    assert.equal(result.code, 0, `${result.name} failed; inspect its log.`);
  }
  for (const artifact of [
    "wear/build/outputs/bundle/release/wear-release.aab",
    "app/build/outputs/bundle/playRelease/app-play-release.aab",
  ]) {
    execFileSync("jarsigner", ["-verify", path.join(android, artifact)], { stdio: "ignore" });
  }
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
} finally {
  clearInterval(sampler);
  samples.push(resources());
  const result = {
    variant: values.variant,
    sourceSha: expectedSource,
    plan,
    host,
    stages,
    measuredSeconds: measuredStart ? (performance.now() - measuredStart) / 1000 : null,
  };
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(output, "resources.json"), JSON.stringify(samples));
  const profiles = path.join(android, "build/reports/profile");
  if (fs.existsSync(profiles)) {
    fs.cpSync(profiles, path.join(output, "gradle-profile"), { recursive: true });
  }
  execFileSync("./gradlew", ["--stop"], { cwd: android, env: buildEnv, stdio: "ignore" });
  fs.rmSync(signing);
  console.log(
    JSON.stringify({ variant: values.variant, measuredSeconds: result.measuredSeconds, stages }),
  );
}
