// Nonpublishing unsigned archive measurement, not release qualification. Use a clean source root.
// node scripts/bench-ios-release-note-overlap.mjs --root ROOT --plan PLAN --output DIR
// PLAN: { sourceSha, gatewayVersion, appStoreRevision, appStoreVersion, buildNumber,
//         releaseNotesBaselines: [{ audience: "ios", version, build }] }
// Use a local explicit build identity; this helper never consults App Store Connect.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    plan: { type: "string" },
    output: { type: "string" },
    samples: { type: "string", default: "5" },
    "warmup-only": { type: "boolean", default: false },
  },
});
assert(
  values.plan && values.output,
  "Supply a frozen release --plan and task-owned --output directory.",
);
const root = fs.realpathSync(values.root);
const output = path.resolve(values.output);
const samples = Number(values.samples);
assert(
  Number.isSafeInteger(samples) && samples >= 5,
  "Use at least five interleaved samples per variant.",
);
const planBytes = fs.readFileSync(path.resolve(values.plan));
const plan = JSON.parse(planBytes);
const sync = (command, args, env = process.env) =>
  execFileSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
const sha = sync("git", ["rev-parse", "HEAD"]);
assert.equal(plan.sourceSha, sha, "Bind the frozen plan to the clean source commit.");
assert.equal(
  sync("git", ["status", "--porcelain", "--untracked-files=all"]),
  "",
  "Keep the benchmark source clean.",
);
assert(
  plan.gatewayVersion &&
    Number.isInteger(plan.appStoreRevision) &&
    Number.isInteger(plan.buildNumber),
  "Plan needs gatewayVersion, appStoreRevision, and buildNumber.",
);
const relativeOutput = path.relative(root, output);
if (
  !relativeOutput.startsWith(`..${path.sep}`) &&
  relativeOutput !== ".." &&
  !path.isAbsolute(relativeOutput)
) {
  assert(relativeOutput, "Keep --output outside tracked source.");
  sync("git", ["check-ignore", "--quiet", relativeOutput]);
}
if (fs.existsSync(output) && !fs.existsSync(path.join(output, "manifest.json"))) {
  assert.equal(fs.readdirSync(output).length, 0, "Use an empty task-owned --output directory.");
}
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const manifestPath = path.join(output, "manifest.json");
const identity = {
  sha,
  codeSigningAllowed: false,
  planSha256: createHash("sha256").update(planBytes).digest("hex"),
  node: process.version,
  xcode: sync("xcodebuild", ["-version"]),
  cpuCount: os.availableParallelism(),
  totalMemoryBytes: os.totalmem(),
};
let manifest;
if (fs.existsSync(manifestPath)) {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(
    manifest.identity,
    identity,
    "Source, plan, toolchain or host resources changed; use a new output directory.",
  );
} else {
  manifest = {
    identity,
    buildTimestamp: new Date().toISOString(),
    rule: "5+ interleaved warm samples per arm; compare median/p95 archive and notes+archive wall, task counts, compilation replay misses and resource samples; any >=20% phase regression requires investigation, not a noise dismissal.",
    scope:
      "Canonical generated App Store inputs and clean/archive arguments with isolated DerivedData/package-cache/CAS and CODE_SIGNING_ALLOWED=NO; signing, Fastlane export, validation, upload and distribution are excluded. Local host only; not hosted release qualification.",
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
const env = {
  ...process.env,
  GIT_COMMIT: sha,
  GIT_SHA: sha,
  OPENCLAW_BUILD_TIMESTAMP: manifest.buildTimestamp,
  XCODE_XCCONFIG_FILE: path.join(root, "apps/ios/build/AppStoreRelease.xcconfig"),
  OPENCLAW_WATCH_RTC_CACHE_DIR: path.join(output, "watch-rtc-cache"),
  OPENCLAW_IOS_COMPILATION_CACHE_DIR: path.join(output, "compilation-cache"),
};
delete env.OPENAI_API_KEY;
delete env.OP_SERVICE_ACCOUNT_TOKEN;
const active = new Set();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    interrupted = true;
    for (const child of active) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* Child already exited. */
      }
    }
  });
}
const frozenPlan = path.join(output, "plan.json");
if (!fs.existsSync(frozenPlan)) {
  fs.writeFileSync(frozenPlan, planBytes, { mode: 0o600, flag: "wx" });
}
function start(command, args, log, childEnv = env) {
  assert(!interrupted, "Benchmark interrupted.");
  const descriptor = fs.openSync(log, "w", 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd: root,
      env: childEnv,
      stdio: ["ignore", descriptor, descriptor],
      detached: true,
    });
  } finally {
    fs.closeSync(descriptor);
  }
  active.add(child);
  const started = performance.now();
  const result = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      active.delete(child);
      reject(new Error(`Unable to start ${command}.`, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      active.delete(child);
      resolve({ code, signal, seconds: (performance.now() - started) / 1000 });
    });
  });
  // Callers always join both children before reporting a failed pair.
  return result;
}
function sourceCheck() {
  sync(
    "/bin/bash",
    ["scripts/apple-release-source-check.sh", "--root", root, "--expected-commit", sha],
    env,
  );
}
async function archive(label) {
  sourceCheck();
  const archivePath = path.join(output, "archive.xcarchive");
  fs.rmSync(archivePath, { recursive: true, force: true });
  const log = path.join(output, `${label}-archive.log`);
  const timeline = path.join(output, `${label}-resources.jsonl`);
  const result = await start(
    process.execPath,
    [
      "scripts/ios-resource-timeline.mjs",
      "--output",
      timeline,
      "--",
      "xcodebuild",
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClaw",
      "-configuration",
      "Release",
      "-showBuildTimingSummary",
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      archivePath,
      "-derivedDataPath",
      path.join(output, "DerivedData"),
      "-packageCachePath",
      path.join(output, "package-cache"),
      "COMPILATION_CACHE_ENABLE_CACHING=YES",
      "COMPILATION_CACHE_ENABLE_DIAGNOSTIC_REMARKS=YES",
      `COMPILATION_CACHE_CAS_PATH=${env.OPENCLAW_IOS_COMPILATION_CACHE_DIR}`,
      "CODE_SIGNING_ALLOWED=NO",
      "clean",
      "archive",
    ],
    log,
  );
  if (result.code !== 0) {
    throw new Error(
      `${label} archive failed (code=${result.code}, signal=${result.signal}); inspect its private archive log.`,
    );
  }
  const text = fs.readFileSync(log, "utf8");
  const resourceRows = fs
    .readFileSync(timeline, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const sampled = resourceRows.filter((row) => row.type === "sample");
  const busy = sampled
    .map((row) => row.host.cpuPercent)
    .filter(Boolean)
    .map((row) => 100 - row.idle);
  const memory = sampled.map((row) => row.host.memory).filter(Boolean);
  const tasks = Object.fromEntries(
    [
      "SwiftCompile ",
      "CompileC ",
      "Ld ",
      "CodeSign ",
      "CompileAssetCatalogVariant ",
      "PhaseScriptExecution ",
    ].map((task) => [task.trim(), text.split("\n").filter((line) => line.startsWith(task)).length]),
  );
  return {
    archiveSeconds: result.seconds,
    taskCounts: tasks,
    replayHits: (text.match(/replay cache hit/giu) ?? []).length,
    replayMisses: (text.match(/replay cache miss/giu) ?? []).length,
    resourceSamples: sampled.length,
    meanBusyCpuPercent: busy.length ? busy.reduce((a, b) => a + b, 0) / busy.length : null,
    pressureLevels: [...new Set(sampled.map((row) => row.host.pressureLevel))],
    peakCompressedMemoryBytes: memory.length
      ? Math.max(...memory.map((row) => row.compressedResidentBytes ?? 0))
      : null,
    swapOutBytes: memory.length
      ? Math.max(...memory.map((row) => row.swapoutsBytes ?? 0)) -
        Math.min(...memory.map((row) => row.swapoutsBytes ?? 0))
      : null,
  };
}
let baselineIdentity;
async function notes(label) {
  const result = await start(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/mobile-release-notes.ts",
      "generate",
      "--platform",
      "ios",
      "--plan",
      frozenPlan,
      "--output",
      path.join(output, `${label}-notes.json`),
    ],
    path.join(output, `${label}-notes.log`),
    { ...env, OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  );
  if (result.code !== 0) {
    throw new Error(
      `${label} release notes failed (code=${result.code}, signal=${result.signal}); inspect its private notes log.`,
    );
  }
  const artifact = JSON.parse(fs.readFileSync(path.join(output, `${label}-notes.json`), "utf8"));
  const baselines = artifact.entries.map((entry) => entry.baseline);
  baselineIdentity ??= baselines;
  assert.deepEqual(
    baselines,
    baselineIdentity,
    "Published baseline source mapping changed during the comparison.",
  );
  return result.seconds;
}
try {
  const prep = await start(
    "/bin/bash",
    [
      "scripts/ios-release-prepare.sh",
      "--version",
      plan.gatewayVersion,
      "--revision",
      String(plan.appStoreRevision),
      "--build-number",
      String(plan.buildNumber),
    ],
    path.join(output, "prepare.log"),
  );
  assert.equal(prep.code, 0, "Release preparation failed; inspect private prepare.log.");
  const versionSettings = fs.readFileSync(
    path.join(root, "apps/ios/build/Version.xcconfig"),
    "utf8",
  );
  assert(
    versionSettings.includes(`OPENCLAW_BUILD_TIMESTAMP = ${manifest.buildTimestamp}`),
    "Preparation changed the frozen build timestamp.",
  );
  const preparedInputs = createHash("sha256");
  for (const input of [
    "apps/ios/build/Version.xcconfig",
    "apps/ios/build/AppStoreRelease.xcconfig",
    "apps/ios/SwiftSources.input.xcfilelist",
    "apps/ios/OpenClaw.xcodeproj/project.pbxproj",
  ]) {
    preparedInputs.update(input).update(fs.readFileSync(path.join(root, input)));
  }
  const preparedInputsSha256 = preparedInputs.digest("hex");
  manifest.preparedInputsSha256 ??= preparedInputsSha256;
  assert.equal(
    preparedInputsSha256,
    manifest.preparedInputsSha256,
    "Regenerated archive inputs changed after warmup.",
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  sourceCheck();
  const warmupPath = path.join(output, "warmup.json");
  if (!fs.existsSync(warmupPath)) {
    console.log(JSON.stringify({ phase: "warmup-start", identity }));
    const warmup = await archive("warmup");
    fs.writeFileSync(warmupPath, JSON.stringify(warmup, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(JSON.stringify({ phase: "warmup-complete", ...warmup }));
  }
  if (!values["warmup-only"]) {
    assert(
      process.env.OPENAI_API_KEY?.trim(),
      "OPENAI_API_KEY is required for the real notes generator.",
    );
    const rowsPath = path.join(output, "rows.json");
    assert(
      !fs.existsSync(rowsPath),
      "Use a new output directory after a started measurement campaign.",
    );
    console.log(JSON.stringify({ phase: "notes-warmup-start" }));
    const notesWarmupSeconds = await notes("warmup");
    console.log(JSON.stringify({ phase: "notes-warmup-complete", notesWarmupSeconds }));
    const rows = [];
    fs.writeFileSync(rowsPath, "[]\n", { mode: 0o600, flag: "wx" });
    for (let sample = 1; sample <= samples; sample++) {
      for (const variant of ["serial", "overlap"]) {
        const label = `${sample}-${variant}`;
        const load = os.loadavg();
        const freeBytes = os.freemem();
        const started = performance.now();
        let notesSeconds, built;
        if (variant === "serial") {
          notesSeconds = await notes(label);
          built = await archive(label);
        } else {
          const results = await Promise.allSettled([notes(label), archive(label)]);
          const failure = results.find((row) => row.status === "rejected");
          if (failure) {
            throw failure.reason;
          }
          notesSeconds = results[0].value;
          built = results[1].value;
        }
        sourceCheck();
        const row = {
          sample,
          variant,
          notesSeconds,
          totalSeconds: (performance.now() - started) / 1000,
          ...built,
          load,
          freeBytes,
        };
        rows.push(row);
        fs.writeFileSync(rowsPath, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
        console.log(JSON.stringify(row));
      }
    }
    const summary = Object.fromEntries(
      ["serial", "overlap"].map((variant) => {
        const selected = rows.filter((row) => row.variant === variant);
        const metrics = Object.fromEntries(
          ["archiveSeconds", "notesSeconds", "totalSeconds"].map((key) => {
            const sorted = selected.map((row) => row[key]).toSorted((a, b) => a - b);
            return [
              key,
              {
                min: sorted[0],
                median:
                  (sorted[Math.floor((sorted.length - 1) / 2)] +
                    sorted[Math.floor(sorted.length / 2)]) /
                  2,
                p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
                max: sorted.at(-1),
              },
            ];
          }),
        );
        return [variant, { samples: selected.length, ...metrics }];
      }),
    );
    fs.writeFileSync(
      path.join(output, "summary.json"),
      JSON.stringify({ identity, notesWarmupSeconds, summary }, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    console.log(JSON.stringify({ summary }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
