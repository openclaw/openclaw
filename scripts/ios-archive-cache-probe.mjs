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
if (!["prepare", "warmup", "baseline", "candidate", "compare", "report"].includes(phase)) {
  throw new Error("Invalid campaign phase");
}
if (
  ["baseline", "candidate"].includes(phase) &&
  (!Number.isInteger(sample) || sample < 1 || sample > 2)
) {
  throw new Error("Expected cold-cache pair 1 or 2");
}
const env = { ...process.env, IOS_DEVELOPMENT_TEAM: "FWJYW4S8P8", CARGO_BUILD_JOBS: "2" };
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
mkdirSync(probe, { recursive: true });
env.GIT_COMMIT = run("git", ["rev-parse", "HEAD"]);
const gatewayVersion = load(path.join(root, "package.json")).version;
if (phase === "prepare") {
  const reference = "5581460a5710088e5c6c918782ff47138470b945";
  const changed = run("git", ["diff", "--name-only", reference, env.GIT_COMMIT])
    .split("\n")
    .filter(Boolean);
  if (
    env.GIT_COMMIT !== env.GITHUB_SHA ||
    changed.some(
      (file) =>
        ![
          ".github/workflows/ios-store-release.yml",
          "scripts/ios-archive-cache-probe.mjs",
        ].includes(file),
    ) ||
    run("git", ["status", "--porcelain"])
  ) {
    throw new Error(
      "Cold comparison requires the unchanged signed-qualification source and clean pinned tooling",
    );
  }
  const contract = {
    source: env.GIT_COMMIT,
    reference,
    changed,
    xcode: run("xcodebuild", ["-version"]),
    preparation: "One unmeasured canonical cache-disabled signed archive/export",
    order: ["warmup-0", "baseline-1", "candidate-1", "candidate-2", "baseline-2"],
    freshState: "Remove DerivedData and all CAS storage before EVERY archive; no CAS transfers",
    acceptance: {
      wall: "For each pair i: 100 * (candidateSeconds[i] / baselineSeconds[i] - 1) < 20; arithmetic mean of the two paired percentages < 20",
      memory:
        "For each pair i: candidate maximum process RSS / baseline maximum process RSS < 1.20",
      correctness:
        "Both signed export semantic comparisons accepted; six corruption controls rejected on pair 1",
      inputs:
        "Same source, Xcode, release metadata per pair; exact declared serial order; empty CAS and fresh DerivedData",
    },
    priorEvidence: {
      run: "https://github.com/openclaw/openclaw/actions/runs/42161600259",
      reportSha256: "36702a380bade4d30403f3a51af18a014d53cff080116999b4528e391d4367ee",
      xcode: "Xcode 27.1\nBuild version 27A9275",
      reuse:
        "Warm replay, semantic comparator controls and source invalidation only if unchanged inputs/toolchain; original overall result remains failed",
    },
    limitation:
      "Two balanced pairs on one prepared runner; cold CAS, not a pristine machine or statistical production qualification",
  };
  json(path.join(probe, "source-contract.json"), contract);
  console.log(JSON.stringify(contract, null, 2));
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
} else if (phase === "compare") {
  // Compare after all measured work so decoding cannot favor either order.
  for (const index of [1, 2]) {
    run(
      "python3",
      [
        "-B",
        "scripts/ios-archive-cache-compare.py",
        path.join(probe, `baseline-${index}`),
        path.join(probe, `candidate-${index}`),
        "--output",
        path.join(probe, `candidate-${index}/comparison.json`),
        ...(index === 1 ? ["--negative-controls"] : []),
      ],
      { stdio: "inherit" },
    );
  }
} else if (phase === "report") {
  const contract = load(path.join(probe, "source-contract.json"));
  const warmup = load(path.join(probe, "warmup-0/summary.json"));
  const pairs = [1, 2].map((index) => {
    const baseline = load(path.join(probe, `baseline-${index}/summary.json`));
    const candidate = load(path.join(probe, `candidate-${index}/summary.json`));
    return {
      sample: index,
      baseline,
      candidate,
      wallOverheadPercent: (candidate.wallSeconds / baseline.wallSeconds - 1) * 100,
      rssRatio: candidate.time.maximumResidentSetSize / baseline.time.maximumResidentSetSize,
      comparison: load(path.join(probe, `candidate-${index}/comparison.json`)),
    };
  });
  const cases = [
    warmup,
    pairs[0].baseline,
    pairs[0].candidate,
    pairs[1].candidate,
    pairs[1].baseline,
  ];
  const report = {
    sourceContract: contract,
    warmup,
    pairs,
    meanPairedWallOverheadPercent:
      pairs.reduce((sum, pair) => sum + pair.wallOverheadPercent, 0) / pairs.length,
    priorEvidenceApplicable: contract.xcode === contract.priorEvidence.xcode,
  };
  report.checks = {
    inputs: cases.every(
      (entry) =>
        entry.source === contract.source &&
        entry.xcode === contract.xcode &&
        entry.freshDerivedData &&
        entry.emptyCas &&
        entry.caching === (entry.phase === "candidate" ? "YES" : "NO"),
    ),
    order: cases.every(
      (entry, index) =>
        `${entry.phase}-${entry.sample}` === contract.order[index] &&
        (index === 0 || Date.parse(entry.startedAt) > Date.parse(cases[index - 1].finishedAt)),
    ),
    metadata: pairs.every(({ baseline, candidate }) =>
      ["gatewayVersion", "revision", "buildNumber", "buildTimestamp"].every((field) =>
        equal(baseline[field], candidate[field]),
      ),
    ),
    coldSharedModules: pairs.every(({ candidate }) =>
      ["OpenClawProtocol", "OpenClawKit", "OpenClawChatUI"].every(
        (target) => candidate.replay[target]?.miss > 0 && candidate.replay[target]?.hit === 0,
      ),
    ),
    semanticComparisons: pairs.every((pair) => pair.comparison.accepted),
    negativeControls: pairs[0].comparison.negativeControlsPassed === true,
    wallEachPair: pairs.every(
      (pair) => pair.candidate.wallSeconds < pair.baseline.wallSeconds * 1.2,
    ),
    wallMean: report.meanPairedWallOverheadPercent < 20,
    rssEachPair: pairs.every((pair) => pair.rssRatio < 1.2),
  };
  report.accepted = Object.values(report.checks).every(Boolean);
  json(path.join(probe, "report.json"), report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.accepted) {
    throw new Error("Prospective cold-cache comparison failed; see report checks");
  }
} else {
  const caseDir = path.join(probe, `${phase}-${sample}`);
  mkdirSync(caseDir);
  rmSync(path.join(probe, "DerivedData"), { recursive: true, force: true });
  rmSync(path.join(probe, "cache"), { recursive: true, force: true });
  mkdirSync(path.join(probe, "cache", "cas"), { recursive: true });
  if (run("git", ["status", "--porcelain"])) {
    throw new Error("Probe source must be clean");
  }
  run("git", ["checkout-index", "--all", "--force"]);
  env.OPENCLAW_BUILD_TIMESTAMP = `2026-11-06T00:0${sample}:00.000Z`;
  env.OPENCLAW_IOS_ARCHIVE_PROBE_DIR = caseDir;
  env.OPENCLAW_IOS_ARCHIVE_PROBE_CACHING = phase === "candidate" ? "YES" : "NO";
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
    freshDerivedData: true,
    emptyCas: true,
    caching: env.OPENCLAW_IOS_ARCHIVE_PROBE_CACHING,
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
  if (sourceMarker.original < 1 || sourceMarker.changed !== 0) {
    throw new Error("Exported main executable does not contain the unchanged source marker");
  }
  console.log(
    JSON.stringify({ phase, sample, wallSeconds: metadata.wallSeconds, time, replay }, null, 2),
  );
}
