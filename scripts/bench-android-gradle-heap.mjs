// Temporary, nonpublishing 3 GiB versus 4 GiB Gradle heap experiment.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const sourceSha = "22b1aacbc054c003f6a7762d78b7c49da855ef38";
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    output: { type: "string" },
  },
});
function bundleTaskInventory(directory) {
  const profiles = fs.readdirSync(directory).filter((file) => file.endsWith(".html"));
  const bundleProfiles = profiles
    .map((file) => fs.readFileSync(path.join(directory, file), "utf8"))
    .filter((html) =>
      /Profiled build: .*:wear:bundleRelease.*:app:bundlePlayRelease|Profiled build: .*:app:bundlePlayRelease.*:wear:bundleRelease/u.test(
        html,
      ),
    );
  assert.equal(bundleProfiles.length, 1, "Expected one complete bundle profile.");
  const table = bundleProfiles[0].split('id="tab4"')[1]?.split("</table>")[0];
  assert.ok(table, "Missing task execution table.");
  const tasks = [
    ...table.matchAll(
      /<td class="indentPath">([^<]+)<\/td>\s*<td class="numeric">[^<]+<\/td>\s*<td>([^<]*)<\/td>/gu,
    ),
  ]
    .map((match) => ({ task: match[1], outcome: match[2] || "executed" }))
    .toSorted((left, right) => left.task.localeCompare(right.task));
  assert.ok(tasks.length > 0, "Profile must include tasks.");
  assert.equal(
    new Set(tasks.map(({ task }) => task)).size,
    tasks.length,
    "Profile tasks must be unique.",
  );
  return tasks;
}

assert.equal(process.platform, "linux", "Run only on a fresh Linux CI runner.");
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
const baselineJvmArgs = fs
  .readFileSync(path.join(android, "gradle.properties"), "utf8")
  .match(/^org\.gradle\.jvmargs=(.+)$/m)?.[1];
assert.equal(
  baselineJvmArgs,
  "-Xmx3g -Dfile.encoding=UTF-8 --enable-native-access=ALL-UNNAMED -XX:+UseParallelGC",
);
const candidateJvmArgs = baselineJvmArgs.replace("-Xmx3g", "-Xmx4g");
const scratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "android-gradle-heap-"));
assert.ok(source.startsWith(`${process.env.GITHUB_WORKSPACE}/`));
assert.notEqual(source, process.env.GITHUB_WORKSPACE);
const sourceSeed = path.join(scratch, "source");
const cacheSeed = path.join(scratch, "gradle");
const signing = path.join(scratch, "disposable.jks");
const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
const result = {
  sourceSha,
  baselineJvmArgs,
  candidateJvmArgs,
  acceptance: {
    samplesPerVariant: 5,
    minimumMedianSavingPercent: 5,
    minimumMedianSavingSeconds: 5,
    minimumPairWins: 4,
    bundleP95MustNotRegress: true,
    fullMedianMustNotRegress: true,
    medianJavaCpuMustNotRegress: true,
    peakJavaRssMustNotRegress: true,
    noOom: true,
    taskAndSignatureCoverageMustMatch: true,
    twentyPercentRegressionStopsShipping: true,
  },
  identity: {
    version: "2026.11.11",
    phoneCode: 2026090546,
    wearCode: 2026090547,
    timestamp: "2026-11-07T02:20:00.000Z",
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
  console.log(JSON.stringify({ pair: current.pair, variant: current.variant, name, ...stage }));
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
  // Restore pristine source and dependency snapshots at the same paths for each
  // sample; task outputs and live JVMs never carry into the next build.
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
  for (let index = 0; index < 10; index++) {
    const pair = String(Math.floor(index / 2) + 1).padStart(2, "0");
    const baselineFirst = Math.floor(index / 2) % 2 === 0;
    const variant = (index % 2 === 0) === baselineFirst ? "baseline" : "heap-4g";
    fs.rmSync(source, { recursive: true });
    fs.rmSync(gradleHome, { recursive: true });
    copy(sourceSeed, source);
    copy(cacheSeed, gradleHome);
    assert.equal(git("rev-parse", "HEAD"), sourceSha);
    assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
    current = {
      pair,
      variant,
      output: path.join(output, pair, variant),
      stages: {},
      status: "failed",
    };
    fs.mkdirSync(current.output, { recursive: true });
    const jvmArgs = `-Dorg.gradle.jvmargs=${variant === "baseline" ? baselineJvmArgs : candidateJvmArgs}`;
    result.samples.push(current);
    resources = [snapshot()];
    sampler = setInterval(() => {
      const resource = snapshot();
      resources.push(resource);
    }, 1000);
    let sampleFailure;
    try {
      await run("preflight", "./gradlew", [
        ...metadata,
        jvmArgs,
        ":app:validateSigningPlayRelease",
        ":wear:validateSigningRelease",
        ...flags,
      ]);
      const tasks = [":wear:bundleRelease", ":app:bundlePlayRelease"];
      await run("build", "./gradlew", [...metadata, jvmArgs, ...tasks, ...flags]);
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
      current.tasks = bundleTaskInventory(path.join(android, "build/reports/profile"));
      current.actionable = [...log.matchAll(/^\d+ actionable tasks:.*$/gm)].at(-1)?.[0];
      assert.equal(current.actionable, "149 actionable tasks: 146 executed, 3 up-to-date");
      assert.equal(current.tasks.length, 163);
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
  for (const sample of result.samples) {
    assert.deepEqual(
      sample.tasks,
      result.samples[0].tasks,
      "Task coverage and outcomes must match.",
    );
  }
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
