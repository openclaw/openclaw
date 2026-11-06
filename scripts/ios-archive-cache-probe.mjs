// Temporary unsigned capability probe; never exports or uploads an IPA.
// One cold producer and one fresh-runner cold/candidate pair at the same SHA.
// Capability passes only with first-party replay hits and identical same-host
// executable hashes; report cache transfer separately. This is not performance
// acceptance: production adoption still needs five interleaved samples per arm,
// full signed-artifact validation, and median/p95/resource comparisons.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = path.join(process.env.RUNNER_TEMP, "ios-archive-cache-probe");
const mode = process.env.PROBE_MODE;
if (!["producer", "consumer"].includes(mode)) {
  throw new Error("Invalid PROBE_MODE");
}
const phase = process.argv[2];
if (!["prepare", "cold", "candidate"].includes(phase)) {
  throw new Error("Invalid phase");
}
if (phase === "candidate" && mode !== "consumer") {
  throw new Error("Candidate requires consumer");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}: ${result.stderr ?? ""}`);
  }
  return result.stdout?.trim();
}
function json(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
const env = {
  ...process.env,
  IOS_DEVELOPMENT_TEAM: "FWJYW4S8P8",
  OPENCLAW_BUILD_TIMESTAMP: "2026-11-05T00:00:00.000Z",
  XCODE_XCCONFIG_FILE: path.join(root, "apps/ios/build/AppStoreRelease.xcconfig"),
  CARGO_BUILD_JOBS: "2",
};
env.GIT_COMMIT = run("git", ["rev-parse", "HEAD"]);
mkdirSync(probe, { recursive: true });

if (phase === "prepare") {
  run(
    "/bin/bash",
    [
      "scripts/ios-release-prepare.sh",
      "--version",
      "2026.11.1",
      "--revision",
      "0",
      "--build-number",
      "4",
    ],
    { stdio: "inherit" },
  );
  run(
    "/bin/bash",
    [
      "apps/shared/OpenClawWatchRTC/build.sh",
      "watchos",
      path.join(probe, "WatchRTC"),
      "arm64",
      "arm64_32",
    ],
    { stdio: "inherit" },
  );
} else {
  const caseDir = path.join(probe, phase);
  const cache = path.join(probe, "cache");
  const cas =
    phase === "cold" && mode === "consumer"
      ? path.join(probe, "cold-cas")
      : path.join(cache, "cas");
  const derivedData = path.join(probe, "DerivedData");
  rmSync(derivedData, { recursive: true, force: true });
  if (phase === "cold") {
    rmSync(cas, { recursive: true, force: true });
  }
  mkdirSync(caseDir);
  const archive = path.join(caseDir, "OpenClaw.xcarchive");
  const resultBundle = path.join(caseDir, "Archive.xcresult");
  const command = [
    "xcodebuild",
    "-project",
    path.join(root, "apps/ios/OpenClaw.xcodeproj"),
    "-scheme",
    "OpenClaw",
    "-configuration",
    "Release",
    "-showBuildTimingSummary",
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    archive,
    "-derivedDataPath",
    derivedData,
    "-clonedSourcePackagesDirPath",
    path.join(root, "apps/ios/build/SourcePackages"),
    "-resultBundlePath",
    resultBundle,
    "-jobs",
    "5",
    "COMPILATION_CACHE_ENABLE_CACHING=YES",
    "COMPILATION_CACHE_ENABLE_DIAGNOSTIC_REMARKS=YES",
    `COMPILATION_CACHE_CAS_PATH=${cas}`,
    "CODE_SIGNING_ALLOWED=NO",
    "clean",
    "archive",
  ];
  const metadata = {
    mode,
    phase,
    source: env.GIT_COMMIT,
    root,
    derivedData,
    cas,
    command,
    host: hostname(),
    runner: process.env.RUNNER_NAME,
    xcode: run("xcodebuild", ["-version"]),
    startedAt: new Date().toISOString(),
  };
  json(path.join(caseDir, "run.json"), metadata);
  const logFile = path.join(caseDir, "archive.log");
  const log = openSync(logFile, "w");
  const start = performance.now();
  try {
    run(
      "node",
      [
        "scripts/ios-resource-timeline.mjs",
        "--output",
        path.join(caseDir, "resource-timeline.jsonl"),
        "--",
        ...command,
      ],
      { stdio: ["ignore", log, log] },
    );
  } finally {
    closeSync(log);
    metadata.wallSeconds = (performance.now() - start) / 1000;
    metadata.finishedAt = new Date().toISOString();
    json(path.join(caseDir, "run.json"), metadata);
    console.log(readFileSync(logFile, "utf8").slice(-8192));
  }
  const buildLogFile = path.join(caseDir, "build-log.json");
  const buildLog = openSync(buildLogFile, "w");
  try {
    run(
      "xcrun",
      ["xcresulttool", "get", "log", "--path", resultBundle, "--type", "build", "--compact"],
      { stdio: ["ignore", buildLog, "inherit"] },
    );
  } finally {
    closeSync(buildLog);
  }
  const executables = {};
  for (const file of [
    "OpenClaw",
    "Watch/OpenClawWatchApp.app/OpenClawWatchApp",
    "PlugIns/OpenClawActivityWidget.appex/OpenClawActivityWidget",
    "PlugIns/OpenClawShareExtension.appex/OpenClawShareExtension",
  ]) {
    const executable = path.join(archive, "Products/Applications/OpenClaw.app", file);
    const bytes = readFileSync(executable);
    executables[file] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      architectures: run("xcrun", ["lipo", "-archs", executable]),
    };
  }
  const replay = {};
  for (const match of readFileSync(logFile, "utf8").matchAll(
    /note: Replay cache (hit|miss) \(in target '([^']+)'/g,
  )) {
    const counts = (replay[match[2]] ??= { hit: 0, miss: 0 });
    counts[match[1]]++;
  }
  const build = JSON.parse(readFileSync(buildLogFile, "utf8"));
  const summary = {
    ...metadata,
    archiveSeconds: build.subsections.find((section) =>
      section.title.startsWith("Archiving project "),
    ).duration,
    executables,
    replay,
  };
  json(path.join(caseDir, "summary.json"), summary);
  if (phase === "cold" && mode === "producer") {
    json(path.join(cache, "reference.json"), summary);
  }
  if (phase === "candidate") {
    const cold = JSON.parse(readFileSync(path.join(probe, "cold/summary.json"), "utf8"));
    const producer = JSON.parse(readFileSync(path.join(cache, "reference.json"), "utf8"));
    const comparison = {
      sameRunnerExecutablesIdentical:
        JSON.stringify(cold.executables) === JSON.stringify(executables),
      producerExecutablesIdentical:
        JSON.stringify(producer.executables) === JSON.stringify(executables),
      producerSource: producer.source,
      consumerSource: summary.source,
      coldSeconds: cold.archiveSeconds,
      candidateSeconds: summary.archiveSeconds,
      replay,
    };
    json(path.join(caseDir, "comparison.json"), comparison);
    console.log(JSON.stringify(comparison, null, 2));
    if (!comparison.sameRunnerExecutablesIdentical) {
      throw new Error("Cold and candidate executables differ");
    }
    if (producer.source !== summary.source) {
      throw new Error("Producer and consumer source differ");
    }
    for (const target of ["OpenClawProtocol", "OpenClawKit", "OpenClawChatUI", "OpenClaw"]) {
      if (!replay[target]?.hit) {
        throw new Error(`No first-party replay hit: ${target}`);
      }
    }
  }
  console.log(JSON.stringify({ archiveSeconds: summary.archiveSeconds, replay }, null, 2));
}
