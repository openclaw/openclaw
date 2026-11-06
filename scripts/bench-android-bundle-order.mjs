// Temporary, nonpublishing paired experiment; derived from bench-android-gradle-cache.mjs.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const sourceSha = "f99d785d2ac6269b37a1c88eb8d5ef2283b76b99";
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    first: { type: "string" },
    output: { type: "string" },
  },
});
assert.equal(process.platform, "linux", "Run only on a fresh Linux CI runner.");
assert.ok(["wear", "phone"].includes(values.first));
assert.ok(values.source && values.output && process.env.RUNNER_TEMP && process.env.HOME);
for (const key of [
  "GOOGLE_PLAY_JSON_KEY_DATA",
  "GOOGLE_PLAY_JSON_KEY",
  "FIREBASE_APP_DISTRIBUTION_JSON_KEY_DATA",
  "MATCH_PASSWORD",
  "OPENAI_API_KEY",
]) {
  assert.ok(!process.env[key], `Credential must be absent: ${key}`);
}
const source = path.resolve(values.source);
const android = path.join(source, "apps/android");
const output = path.resolve(values.output);
fs.mkdirSync(output, { recursive: true });
assert.deepEqual(fs.readdirSync(output), [], "Output must be empty.");
const gradleHome = path.join(process.env.HOME, ".gradle");
assert.equal(process.env.GRADLE_USER_HOME ?? gradleHome, gradleHome);
const scratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "android-bundle-order-"));
assert.ok(source.startsWith(`${process.env.GITHUB_WORKSPACE}/`));
assert.notEqual(source, process.env.GITHUB_WORKSPACE);
const sourceSeed = path.join(scratch, "source");
const cacheSeed = path.join(scratch, "gradle");
const signing = path.join(scratch, "disposable.jks");
const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
const result = {
  sourceSha,
  first: values.first,
  identity: {
    version: "2026.11.11",
    phoneCode: 2026090546,
    wearCode: 2026090547,
    timestamp: "2026-11-07T15:00:00.000Z",
  },
  host: {
    cpus: os.cpus(),
    availableParallelism: os.availableParallelism(),
    memoryBytes: os.totalmem(),
    clockTicks: Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" })),
    pageBytes: Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" })),
  },
  samples: [],
  status: "failed",
};
let current;
let resources = [];
let sampler;

function readOptional(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
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
    if (Number(entry) !== process.pid && name !== "java") {
      continue;
    }
    const fields = raw.slice(closing + 2).split(" ");
    processes.push({
      pid: Number(entry),
      name,
      state: fields[0],
      parentPid: Number(fields[1]),
      userTicks: Number(fields[11]),
      systemTicks: Number(fields[12]),
      startTicks: Number(fields[19]),
      rssPages: Number(fields[21]),
    });
  }
  return processes;
}

function snapshot() {
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

async function run(name, command, args, cwd = android) {
  const started = performance.now();
  const stage = { startedAt: new Date().toISOString(), command, args };
  current.stages[name] = stage;
  const fd = fs.openSync(path.join(current.output, `${name}.log`), "wx", 0o600);
  let child;
  try {
    child = spawn(command, args, { cwd, env: buildEnv, stdio: ["ignore", fd, fd] });
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
  stage.completedAt = new Date().toISOString();
  stage.seconds = (performance.now() - started) / 1000;
  console.log(JSON.stringify({ order: current.order, name, ...stage }));
  assert.equal(stage.code, 0, `${name} failed; inspect its log.`);
}

const buildEnv = {
  ...process.env,
  GRADLE_USER_HOME: gradleHome,
  ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_STORE_FILE: signing,
  ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_STORE_PASSWORD: "benchmark-only",
  ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_KEY_ALIAS: "benchmark",
  ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_KEY_PASSWORD: "benchmark-only",
};
const metadata = [
  `-PopenclawBuildCommit=${sourceSha}`,
  `-PopenclawBuildTimestamp=${result.identity.timestamp}`,
  `-POPENCLAW_ANDROID_VERSION_NAME=${result.identity.version}`,
  `-POPENCLAW_ANDROID_VERSION_CODE=${result.identity.phoneCode}`,
  `-POPENCLAW_ANDROID_WEAR_VERSION_CODE=${result.identity.wearCode}`,
];
const flags = ["--profile", "--info", "--no-build-cache"];
const javaProcesses = () =>
  processStats().filter(({ name, state }) => name === "java" && state !== "Z");
const copy = (from, to) => execFileSync("cp", ["-a", "--reflink=auto", from, to]);

async function stopJava() {
  await run("stop-daemon", "./gradlew", ["--stop"]);
  for (let attempt = 0; attempt < 100; attempt++) {
    const gradle = javaProcesses().some(({ pid }) =>
      readOptional(`/proc/${pid}/cmdline`)?.includes("GradleDaemon"),
    );
    if (!gradle) {
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  // The fresh task-owned runner had no Java processes. Kotlin's compiler daemon
  // can outlive Gradle; terminate it before starting the next measured sample.
  for (const { pid } of javaProcesses()) {
    const command = readOptional(`/proc/${pid}/cmdline`);
    if (!command) {
      continue;
    }
    assert.ok(command?.includes("KotlinCompileDaemon"), `Unexpected Java process ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  for (let attempt = 0; attempt < 100 && javaProcesses().length; attempt++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  assert.deepEqual(javaProcesses(), [], "Every sample must start with fresh Java processes.");
}

try {
  assert.equal(git("rev-parse", "HEAD"), sourceSha);
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
  assert.deepEqual(javaProcesses(), [], "Fresh runner must have no Java processes.");
  assert.ok(fs.existsSync(path.join(gradleHome, "caches/modules-2")), "Dependency cache must hit.");
  result.host.cpuMax = readOptional("/sys/fs/cgroup/cpu.max");
  result.host.memoryMax = readOptional("/sys/fs/cgroup/memory.max");
  result.host.cpuset = readOptional("/sys/fs/cgroup/cpuset.cpus.effective");
  // Freeze both seeds before Gradle runs. Restore identical paths, dependencies,
  // transforms and scripts for each sample; task outputs and JVM warmth never carry over.
  copy(source, sourceSeed);
  copy(gradleHome, cacheSeed);
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
  for (const order of [values.first, values.first === "wear" ? "phone" : "wear"]) {
    fs.rmSync(source, { recursive: true });
    fs.rmSync(gradleHome, { recursive: true });
    copy(sourceSeed, source);
    copy(cacheSeed, gradleHome);
    assert.equal(git("rev-parse", "HEAD"), sourceSha);
    assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
    current = { order, output: path.join(output, order), stages: {}, status: "failed" };
    fs.mkdirSync(current.output);
    result.samples.push(current);
    resources = [snapshot()];
    sampler = setInterval(() => resources.push(snapshot()), 1000);
    let sampleFailure;
    try {
      await run("preflight", "./gradlew", [
        ...metadata,
        ":app:validateSigningPlayRelease",
        ":wear:validateSigningRelease",
        ...flags,
      ]);
      const tasks = [":wear:bundleRelease", ":app:bundlePlayRelease"];
      await run("build", "./gradlew", [
        ...metadata,
        ...(order === "phone" ? tasks.toReversed() : tasks),
        ...flags,
      ]);
      for (const [name, artifact] of [
        ["wear", "wear/build/outputs/bundle/release/wear-release.aab"],
        ["phone", "app/build/outputs/bundle/playRelease/app-play-release.aab"],
      ]) {
        await run(`verify-${name}`, "jarsigner", [
          "-J-Duser.language=en",
          "-J-Duser.country=US",
          "-verify",
          path.join(android, artifact),
        ]);
        assert.match(
          fs.readFileSync(path.join(current.output, `verify-${name}.log`), "utf8"),
          /jar verified\./,
        );
      }
      assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
      const log = fs.readFileSync(path.join(current.output, "build.log"), "utf8");
      current.tasks = [...log.matchAll(/^> Task (:\S+)(?: (.*))?$/gm)].map((match) => ({
        task: match[1],
        outcome: match[2] ?? "executed",
      }));
      current.actionable = [...log.matchAll(/^\d+ actionable tasks:.*$/gm)].at(-1)?.[0];
      current.status = "passed";
    } catch (error) {
      sampleFailure = error instanceof Error ? error : new Error(String(error));
      current.error = error.stack;
    } finally {
      clearInterval(sampler);
      resources.push(snapshot());
      fs.writeFileSync(path.join(current.output, "resources.json"), JSON.stringify(resources));
      const profiles = path.join(android, "build/reports/profile");
      if (fs.existsSync(profiles)) {
        fs.cpSync(profiles, path.join(current.output, "gradle-profile"), { recursive: true });
      }
      await stopJava();
      fs.writeFileSync(path.join(current.output, "result.json"), JSON.stringify(current, null, 2));
    }
    if (sampleFailure) {
      throw sampleFailure;
    }
  }
  assert.deepEqual(
    result.samples[0].tasks.toSorted((a, b) => a.task.localeCompare(b.task)),
    result.samples[1].tasks.toSorted((a, b) => a.task.localeCompare(b.task)),
    "Task coverage and cache outcomes must match.",
  );
  result.status = "passed";
} catch (error) {
  result.error = error.stack;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
}
