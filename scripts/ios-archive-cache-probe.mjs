// Temporary signed campaign, invoked only on the disposable hosted runner.
// Production archive/export/IPA validation stays owned by ios:release:archive.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
  throw new Error("This campaign requires a disposable GitHub runner");
}
const probe = path.join(process.env.RUNNER_TEMP, "ios-archive-cache-probe");
const [phase, sampleText] = process.argv.slice(2);
const sample = Number(sampleText ?? 0);
if (!["prepare", "seed", "baseline", "candidate", "report"].includes(phase)) {
  throw new Error("Invalid campaign phase");
}
if (
  ["baseline", "candidate"].includes(phase) &&
  (!Number.isInteger(sample) || sample < 1 || sample > 5)
) {
  throw new Error("Expected sample 1 through 5");
}
const env = { ...process.env, IOS_DEVELOPMENT_TEAM: "FWJYW4S8P8", CARGO_BUILD_JOBS: "2" };
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
function load(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
function equal(a, b) {
  return isDeepStrictEqual(a, b);
}
function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function plist(file) {
  return JSON.parse(run("plutil", ["-convert", "json", "-o", "-", file]));
}
function walk(directory, prefix = "") {
  return readdirSync(directory)
    .toSorted()
    .flatMap((name) => {
      const relative = path.join(prefix, name);
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      return stat.isDirectory() ? walk(absolute, relative) : [{ relative, absolute, stat }];
    });
}
function payloadManifest(ipa, caseDir, archive) {
  const unpacked = path.join(caseDir, "payload");
  mkdirSync(unpacked);
  run("unzip", ["-q", ipa, "-d", unpacked]);
  const app = path.join(unpacked, "Payload/OpenClaw.app");
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const info = plist(path.join(app, "Info.plist"));
  if (
    info.OpenClawGitCommit !== env.GIT_COMMIT ||
    info.OpenClawBuildTimestamp !== env.OPENCLAW_BUILD_TIMESTAMP ||
    info.CFBundleVersion !== String(100 + sample)
  ) {
    throw new Error("Exported build metadata does not match this sample");
  }
  const bundles = [
    ".",
    "Watch/OpenClawWatchApp.app",
    "PlugIns/OpenClawActivityWidget.appex",
    "PlugIns/OpenClawShareExtension.appex",
  ];
  const signatures = {};
  for (const bundle of bundles) {
    const product = path.join(app, bundle);
    const metadata = plist(path.join(product, "Info.plist"));
    if (
      metadata.CFBundleVersion !== info.CFBundleVersion ||
      metadata.CFBundleShortVersionString !== info.CFBundleShortVersionString
    ) {
      throw new Error(`Nested product version mismatch: ${bundle}`);
    }
    const executable = path.join(product, metadata.CFBundleExecutable);
    const architectures = run("xcrun", ["lipo", "-archs", executable]);
    if (architectures !== (bundle.startsWith("Watch/") ? "arm64 arm64_32" : "arm64")) {
      throw new Error(`Unexpected architecture: ${bundle}: ${architectures}`);
    }
    const symbolFile = path.join(archive, "dSYMs", `${path.basename(product)}.dSYM`);
    const uuids = (file) =>
      [...run("xcrun", ["dwarfdump", "--uuid", file]).matchAll(/UUID: ([0-9A-F-]+) \(([^)]+)\)/g)]
        .map((match) => `${match[2]}:${match[1]}`)
        .toSorted();
    const executableUuids = uuids(executable);
    if (!executableUuids.length || !equal(executableUuids, uuids(symbolFile))) {
      throw new Error(`Archive dSYM does not match exported executable: ${bundle}`);
    }
    const entitlementsFile = path.join(
      caseDir,
      `${Object.keys(signatures).length}-entitlements.plist`,
    );
    const fd = openSync(entitlementsFile, "w");
    try {
      run("codesign", ["-d", "--entitlements", ":-", product], { stdio: ["ignore", fd, "ignore"] });
    } finally {
      closeSync(fd);
    }
    const entitlements = plist(entitlementsFile);
    if (entitlements["com.apple.developer.team-identifier"] !== "FWJYW4S8P8") {
      throw new Error(`Unexpected signing team: ${bundle}`);
    }
    signatures[bundle] = {
      bundleId: metadata.CFBundleIdentifier,
      version: metadata.CFBundleShortVersionString,
      build: metadata.CFBundleVersion,
      architectures,
      executableUuids,
      entitlements,
    };
  }
  // Signatures carry per-signing timestamps. Normalize only this extracted copy,
  // after strict verification; keep all other payload bytes in the comparison.
  const files = walk(app);
  for (const file of files) {
    if (file.stat.isSymbolicLink() || file.relative.split(path.sep).includes("_CodeSignature")) {
      continue;
    }
    const magic = readFileSync(file.absolute).subarray(0, 4).toString("hex");
    if (
      [
        "cefaedfe",
        "cffaedfe",
        "cafebabe",
        "bebafeca",
        "cafebabf",
        "bfbafeca",
        "feedface",
        "feedfacf",
      ].includes(magic)
    ) {
      const signed = spawnSync("codesign", ["-d", file.absolute], { stdio: "ignore" });
      if (signed.status === 0) {
        run("codesign", ["--remove-signature", file.absolute]);
      }
    }
  }
  const manifest = Object.fromEntries(
    walk(unpacked)
      .filter((file) => !file.relative.split(path.sep).includes("_CodeSignature"))
      .map((file) => [
        file.relative,
        file.stat.isSymbolicLink()
          ? { symlink: readlinkSync(file.absolute) }
          : { mode: file.stat.mode & 0o777, sha256: sha(readFileSync(file.absolute)) },
      ]),
  );
  // Keep generated resources for investigating byte differences. These are
  // diagnostic evidence only; no differences are excluded from the comparison.
  for (const file of walk(unpacked)) {
    if (file.stat.isSymbolicLink() || !/\.(car|lzfse|symbols)$/.test(file.relative)) {
      continue;
    }
    const retained = path.join(caseDir, "generated-resources", file.relative);
    mkdirSync(path.dirname(retained), { recursive: true });
    copyFileSync(file.absolute, retained);
    if (file.relative.endsWith(".car")) {
      json(`${retained}.json`, JSON.parse(run("xcrun", ["assetutil", "--info", file.absolute])));
    }
  }
  rmSync(unpacked, { recursive: true });
  return { info, signatures, manifest };
}
function stats(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
    samples: values,
  };
}
mkdirSync(probe, { recursive: true });
env.GIT_COMMIT = run("git", ["rev-parse", "HEAD"]);
const gatewayVersion = load(path.join(root, "package.json")).version;
if (phase === "prepare") {
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
} else if (phase === "report") {
  const pairs = Array.from({ length: 5 }, (_, i) => ({
    baseline: load(path.join(probe, `baseline-${i + 1}/summary.json`)),
    candidate: load(path.join(probe, `candidate-${i + 1}/summary.json`)),
  }));
  const report = {
    source: env.GIT_COMMIT,
    seed: load(path.join(probe, "seed-0/summary.json")),
    baselineWallSeconds: stats(pairs.map((pair) => pair.baseline.wallSeconds)),
    candidateWallSeconds: stats(pairs.map((pair) => pair.candidate.wallSeconds)),
    baselineCpuSeconds: stats(
      pairs.map((pair) => pair.baseline.time.user + pair.baseline.time.sys),
    ),
    candidateCpuSeconds: stats(
      pairs.map((pair) => pair.candidate.time.user + pair.candidate.time.sys),
    ),
    baselineMaximumRssBytes: stats(pairs.map((pair) => pair.baseline.time.maximumResidentSetSize)),
    candidateMaximumRssBytes: stats(
      pairs.map((pair) => pair.candidate.time.maximumResidentSetSize),
    ),
    pairs: pairs.map(({ baseline, candidate }) => ({
      sample: baseline.sample,
      baselineSeconds: baseline.wallSeconds,
      candidateSeconds: candidate.wallSeconds,
      payloadIdentical: equal(baseline.payload, candidate.payload),
      replay: candidate.replay,
    })),
    transferAdjustmentPending: true,
  };
  json(path.join(probe, "report.json"), report);
  console.log(JSON.stringify(report, null, 2));
  if (report.pairs.some((pair) => !pair.payloadIdentical)) {
    throw new Error("Exported baseline/candidate payload or entitlements differ; see comparisons");
  }
} else {
  const caseDir = path.join(probe, `${phase}-${sample}`);
  mkdirSync(caseDir);
  rmSync(path.join(probe, "DerivedData"), { recursive: true, force: true });
  if (phase !== "candidate") {
    rmSync(path.join(probe, "cache"), { recursive: true, force: true });
  }
  if (run("git", ["status", "--porcelain"])) {
    throw new Error("Probe source must be clean");
  }
  run("git", ["checkout-index", "--all", "--force"]);
  env.OPENCLAW_BUILD_TIMESTAMP = `2026-11-06T00:0${sample}:00.000Z`;
  env.OPENCLAW_IOS_ARCHIVE_PROBE_DIR = caseDir;
  env.OPENCLAW_IOS_ARCHIVE_PROBE_CACHING = phase === "baseline" ? "NO" : "YES";
  const resultBundle = path.join(caseDir, "Archive.xcresult");
  const command = [
    "/bin/bash",
    "scripts/ios-release-archive.sh",
    "--version",
    gatewayVersion,
    "--revision",
    String(sample),
    "--build-number",
    String(100 + sample),
  ];
  const metadata = {
    phase,
    sample,
    source: env.GIT_COMMIT,
    gatewayVersion,
    revision: sample,
    buildNumber: 100 + sample,
    buildTimestamp: env.OPENCLAW_BUILD_TIMESTAMP,
    command,
    xcode: run("xcodebuild", ["-version"]),
    startedAt: new Date().toISOString(),
  };
  const logFile = path.join(caseDir, "archive.log");
  const log = openSync(logFile, "w");
  const timeFile = path.join(caseDir, "time.txt");
  const start = performance.now();
  try {
    run(
      "node",
      [
        "scripts/ios-resource-timeline.mjs",
        "--output",
        path.join(caseDir, "resource-timeline.jsonl"),
        "--",
        "/usr/bin/time",
        "-lp",
        "-o",
        timeFile,
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
  const timeText = readFileSync(timeFile, "utf8");
  const time = {};
  for (const key of ["real", "user", "sys"]) {
    time[key] = Number(timeText.match(new RegExp(`^${key}\\s+([\\d.]+)`, "m"))[1]);
  }
  time.maximumResidentSetSize = Number(timeText.match(/(\d+)\s+maximum resident set size/)[1]);
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
  const replay = {};
  for (const match of readFileSync(logFile, "utf8").matchAll(
    /note: Replay cache (hit|miss) \(in target '([^']+)'/g,
  )) {
    const counts = (replay[match[2]] ??= { hit: 0, miss: 0 });
    counts[match[1]]++;
  }
  const ipa = path.join(root, "apps/ios/build/app-store", `OpenClaw-${gatewayVersion}.ipa`);
  const payload = payloadManifest(
    ipa,
    caseDir,
    path.join(root, "apps/ios/build/app-store", `OpenClaw-${gatewayVersion}.xcarchive`),
  );
  const summary = { ...metadata, time, replay, payload, ipaSha256: sha(readFileSync(ipa)) };
  json(path.join(caseDir, "summary.json"), summary);
  if (phase === "candidate") {
    const baseline = load(path.join(probe, `baseline-${sample}/summary.json`));
    const same = equal(baseline.payload, payload);
    const changedFiles = [
      ...new Set([...Object.keys(baseline.payload.manifest), ...Object.keys(payload.manifest)]),
    ].filter((file) => !equal(baseline.payload.manifest[file], payload.manifest[file]));
    json(path.join(caseDir, "comparison.json"), {
      payloadIdentical: same,
      metadataIdentical: equal(baseline.payload.info, payload.info),
      signaturesIdentical: equal(baseline.payload.signatures, payload.signatures),
      changedFiles,
      metadata,
    });
    // Finish collecting the predeclared five pairs, then fail the report if any
    // payload differs. A fast build never overrides the correctness requirement.
    if (!same) {
      console.error(
        `Payload comparison failed for sample ${sample}: ${changedFiles.length} files differ`,
      );
    }
    for (const target of ["OpenClawProtocol", "OpenClawKit", "OpenClawChatUI"]) {
      if (!replay[target]?.hit) {
        throw new Error(`No shared first-party replay hit: ${target}`);
      }
    }
  }
  console.log(
    JSON.stringify({ phase, sample, wallSeconds: metadata.wallSeconds, time, replay }, null, 2),
  );
}
