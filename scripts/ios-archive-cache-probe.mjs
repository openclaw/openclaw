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
  (!Number.isInteger(sample) || sample < 1 || sample > 6)
) {
  throw new Error("Expected performance sample 1 through 5, or invalidation sample 6");
}
const env = { ...process.env, IOS_DEVELOPMENT_TEAM: "FWJYW4S8P8", CARGO_BUILD_JOBS: "2" };
const sourceFile = "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayConnectionProblem.swift";
const originalMarker =
  "Sign in to this gateway in the browser, then continue with OpenClaw pairing.";
const changedMarker = `IOS-CAS-INVALIDATION-CHANGED-${".".repeat(47)}`;
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
    info.OpenClawCanonicalVersion !== gatewayVersion ||
    info.CFBundleShortVersionString !== `${gatewayVersion}${sample}` ||
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
  const executableBytes = readFileSync(path.join(app, "OpenClaw"));
  const countMarker = (marker) => {
    const bytes = Buffer.from(marker);
    let count = 0;
    for (
      let offset = executableBytes.indexOf(bytes);
      offset !== -1;
      offset = executableBytes.indexOf(bytes, offset + bytes.length)
    ) {
      count++;
    }
    return count;
  };
  const sourceMarker = {
    original: countMarker(originalMarker),
    changed: countMarker(changedMarker),
  };
  rmSync(unpacked, { recursive: true });
  return { payload: { info, signatures, manifest }, sourceMarker };
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
async function cacheTransfers() {
  const api = async (suffix) => {
    const response = await fetch(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/${suffix}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Read-only campaign metrics request failed: HTTP ${response.status}`);
    }
    return response.json();
  };
  const jobs = await api(`actions/runs/${env.GITHUB_RUN_ID}/jobs?per_page=100`);
  const job = jobs.jobs.find((entry) => entry.name === "archive-cache-probe");
  if (!job) {
    throw new Error("Campaign job is missing from Actions metrics");
  }
  const seconds = (name) => {
    const step = job.steps.find((entry) => entry.name === name);
    if (step?.conclusion !== "success" || !step.started_at || !step.completed_at) {
      throw new Error(`Missing successful transfer measurement: ${name}`);
    }
    const duration = (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error(`Invalid transfer duration: ${name}`);
    }
    return duration;
  };
  const saveSeconds = seconds("Save immutable signed seed CAS");
  const restoreSeconds = Array.from({ length: 5 }, (_, i) =>
    seconds(`Restore immutable seed CAS for candidate ${i + 1}`),
  );
  const cacheKey = env.OPENCLAW_IOS_ARCHIVE_PROBE_CACHE_KEY;
  const caches = await api(`actions/caches?key=${encodeURIComponent(cacheKey)}&per_page=100`);
  const saved = caches.actions_caches.filter((entry) => entry.key === cacheKey);
  if (saved.length !== 1 || !(saved[0].size_in_bytes > 0)) {
    throw new Error("Immutable seed compressed size is missing or ambiguous");
  }
  return { saveSeconds, restoreSeconds, cacheBytes: saved[0].size_in_bytes, cacheKey };
}
mkdirSync(probe, { recursive: true });
env.GIT_COMMIT = run("git", ["rev-parse", "HEAD"]);
const gatewayVersion = load(path.join(root, "package.json")).version;
if (phase === "prepare") {
  const variant = env.GITHUB_SHA;
  const ordinary = run("git", ["rev-parse", `${variant}^`]);
  if (
    env.GIT_COMMIT !== ordinary ||
    run("git", ["diff", "--name-only", ordinary, variant]) !== sourceFile
  ) {
    throw new Error(
      "Expected ordinary tooling commit followed by only the controlled source change",
    );
  }
  const originalSource = run("git", ["show", `${ordinary}:${sourceFile}`]);
  const changedSource = run("git", ["show", `${variant}:${sourceFile}`]);
  if (
    originalSource.split(originalMarker).length !== 2 ||
    originalSource.replace(originalMarker, changedMarker) !== changedSource
  ) {
    throw new Error("Controlled source revision is not the exact declared marker replacement");
  }
  json(path.join(probe, "source-contract.json"), {
    ordinary,
    variant,
    sourceFile,
    originalMarker,
    changedMarker,
  });
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
  const transfers = await cacheTransfers();
  const seed = load(path.join(probe, "seed-0/summary.json"));
  const invalidation = {
    baseline: load(path.join(probe, "baseline-6/summary.json")),
    candidate: load(path.join(probe, "candidate-6/summary.json")),
    comparison: load(path.join(probe, "candidate-6/comparison.json")),
  };
  const contract = load(path.join(probe, "source-contract.json"));
  const report = {
    source: contract.ordinary,
    sourceContract: contract,
    seed: load(path.join(probe, "seed-0/summary.json")),
    baselineWallSeconds: stats(pairs.map((pair) => pair.baseline.wallSeconds)),
    candidateWallSeconds: stats(pairs.map((pair) => pair.candidate.wallSeconds)),
    candidateAdjustedWallSeconds: stats(
      pairs.map(
        (pair, index) =>
          pair.candidate.wallSeconds + transfers.restoreSeconds[index] + transfers.saveSeconds,
      ),
    ),
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
      comparison: load(path.join(probe, `candidate-${baseline.sample}/comparison.json`)),
      replay: candidate.replay,
    })),
    invalidation,
    transfers,
  };
  report.medianWallReductionPercent =
    (1 - report.candidateAdjustedWallSeconds.median / report.baselineWallSeconds.median) * 100;
  report.coldSeedRegressionPercent =
    (seed.wallSeconds / report.baselineWallSeconds.median - 1) * 100;
  report.checks = {
    fiveOrdinaryPairs:
      seed.source === contract.ordinary &&
      pairs.every(
        ({ baseline, candidate }) =>
          baseline.source === contract.ordinary &&
          candidate.source === contract.ordinary &&
          baseline.xcode === seed.xcode &&
          candidate.xcode === seed.xcode,
      ),
    semanticComparisons: report.pairs.every((pair) => pair.comparison.accepted),
    negativeControls: report.pairs[0].comparison.negativeControlsPassed === true,
    replay: pairs.every(({ candidate }) =>
      ["OpenClawProtocol", "OpenClawKit", "OpenClawChatUI"].every(
        (target) => candidate.replay[target]?.hit > 0,
      ),
    ),
    adjustedMedian: report.medianWallReductionPercent >= 30,
    adjustedP95: report.candidateAdjustedWallSeconds.p95 <= report.baselineWallSeconds.p95,
    cpuMedian: report.candidateCpuSeconds.median <= report.baselineCpuSeconds.median,
    rssMedian: report.candidateMaximumRssBytes.median < report.baselineMaximumRssBytes.median * 1.2,
    rssP95: report.candidateMaximumRssBytes.p95 < report.baselineMaximumRssBytes.p95 * 1.2,
    coldSeed: report.coldSeedRegressionPercent < 20,
    invalidation:
      invalidation.baseline.source === contract.variant &&
      invalidation.candidate.source === contract.variant &&
      invalidation.baseline.xcode === seed.xcode &&
      invalidation.candidate.xcode === seed.xcode &&
      invalidation.comparison.accepted &&
      invalidation.candidate.replay.OpenClawKit?.miss > 0 &&
      invalidation.candidate.replay.OpenClawProtocol?.hit > 0,
    sourceMarkers:
      seed.sourceMarker.original > 0 &&
      seed.sourceMarker.changed === 0 &&
      [invalidation.baseline, invalidation.candidate].every(
        (entry) => entry.sourceMarker.original === 0 && entry.sourceMarker.changed > 0,
      ),
  };
  report.accepted = Object.values(report.checks).every(Boolean);
  json(path.join(probe, "report.json"), report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.accepted) {
    throw new Error("Prospective qualification failed; see report checks and per-pair comparisons");
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
  const { payload, sourceMarker } = payloadManifest(
    ipa,
    caseDir,
    path.join(root, "apps/ios/build/app-store", `OpenClaw-${gatewayVersion}.xcarchive`),
  );
  const summary = {
    ...metadata,
    time,
    replay,
    payload,
    sourceMarker,
    ipaSha256: sha(readFileSync(ipa)),
  };
  json(path.join(caseDir, "summary.json"), summary);
  if (
    sample === 6
      ? sourceMarker.original !== 0 || sourceMarker.changed < 1
      : sourceMarker.original < 1 || sourceMarker.changed !== 0
  ) {
    throw new Error("Exported main executable does not contain the declared source marker");
  }
  if (phase === "candidate") {
    const comparisonPath = path.join(caseDir, "comparison.json");
    const compared = spawnSync(
      "python3",
      [
        "-B",
        "scripts/ios-archive-cache-compare.py",
        path.join(probe, `baseline-${sample}`),
        caseDir,
        "--output",
        comparisonPath,
        ...(sample === 1 ? ["--negative-controls"] : []),
      ],
      { cwd: root, env, stdio: "inherit" },
    );
    if (compared.error || compared.status !== 0 || !load(comparisonPath).accepted) {
      throw new Error(`Semantic comparison failed for sample ${sample}`);
    }
    for (const target of sample === 6
      ? ["OpenClawProtocol"]
      : ["OpenClawProtocol", "OpenClawKit", "OpenClawChatUI"]) {
      if (!replay[target]?.hit) {
        throw new Error(`No shared first-party replay hit: ${target}`);
      }
    }
  }
  console.log(
    JSON.stringify({ phase, sample, wallSeconds: metadata.wallSeconds, time, replay }, null, 2),
  );
}
