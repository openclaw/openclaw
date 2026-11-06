// Temporary production-path cache transport proof. Never merge this harness.
// Only archive/export runs; no upload credentials or publication entry points.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reference = "93168af1689e7bd49e37e86e869e5941914a60ab";
const phase = process.argv[2];
const sample = 1;
const env = { ...process.env, IOS_DEVELOPMENT_TEAM: "FWJYW4S8P8" };
const gatewayVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const workflowPath = ".github/workflows/ios-store-release.yml";
const helperHashes = {
  "ios-archive-cache-symbols.py":
    "493096f7748069543cb5c230d8b4ddb348d2065aed39d23cdcff234d4b686263",
  "ios-archive-cache-compare.py":
    "96a38dbec7978a0290743ff9a19a4de653e29c2ae5f3c9b22d7aaed01d9825d7",
  "ios-archive-cache-assets.py": "0212506f52c8b1b61bbd5cf79b602ca243729c0c02323722727d292d22b9d03f",
};
const allowed = [
  workflowPath,
  "scripts/ios-archive-cache-transport.mjs",
  ...Object.keys(helperHashes).map((name) => `scripts/${name}`),
];
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
  rmSync(unpacked, { recursive: true });
  return { payload: { info, signatures, manifest } };
}
function require(condition, message) {
  if (!condition) throw new Error(message);
}
function sourceGuard() {
  const changed = run("git", ["diff", "--name-only", reference]).split("\n").filter(Boolean);
  require(changed.every((file) =>
    allowed.includes(file),
  ), "Production source changed outside diagnostic tooling");
  const production = run("git", ["show", `${reference}:${workflowPath}`]);
  const current = readFileSync(path.join(root, workflowPath), "utf8");
  function step(source, name) {
    const start = source.indexOf(`      - name: ${name}\n`);
    require(start >= 0, `Missing projected production step: ${name}`);
    const end = source.indexOf("\n      - name: ", start + 1);
    return source.slice(start, end === -1 ? undefined : end).trimEnd();
  }
  const projections = [
    "Identify Watch RTC release cache inputs",
    "Restore Watch RTC release libraries",
    "Restore iOS release source packages",
    "Restore iOS release compilation cache",
    "Save iOS release compilation cache",
    "Save Watch RTC release libraries",
    "Save iOS release source packages",
  ];
  for (const name of projections) {
    require(step(production, name) ===
      step(current, name), `Production projection diverged: ${name}`);
  }
  for (const [name, expected] of Object.entries(helperHashes)) {
    require(sha(readFileSync(path.join(root, "scripts", name))) ===
      expected, `Previously proven semantic comparator changed: ${name}`);
  }
  require(!current.includes("secrets.APP_STORE_CONNECT") &&
    !current.includes(
      "secrets.OPENAI",
    ), "Diagnostic workflow must not receive publication credentials");
  return {
    reference,
    changed,
    productionProjections: projections,
    unchangedComparatorSha256: helperHashes,
  };
}
if (phase === "guard") {
  console.log(JSON.stringify(sourceGuard(), null, 2));
} else {
  require(["prepare", "archive", "report"].includes(
    phase,
  ), "Expected guard, prepare, archive, or report");
  require(env.GITHUB_ACTIONS === "true" &&
    env.RUNNER_TEMP &&
    env.GITHUB_REPOSITORY ===
      "openclaw/openclaw", "This campaign requires a disposable canonical GitHub runner");
  require(env.GITHUB_RUN_ATTEMPT === "1", "Use two new dispatches, never a workflow retry");
  const probe = path.join(env.RUNNER_TEMP, "ios-cas-transport");
  const contractFile = path.join(probe, "source-contract.json");
  const caseDir = path.join(probe, "case");
  const repo = "repos/openclaw/openclaw";
  const api = (suffix) => JSON.parse(run("gh", ["api", `${repo}/${suffix}`]));
  const source = run("git", ["rev-parse", "HEAD"]);
  const xcode = run("xcodebuild", ["-version"]);
  const xcodeHash = sha(`${xcode}\n`);
  const prefix = `ios-release-cas-v1-${env.RUNNER_OS}-${env.RUNNER_ARCH}-${xcodeHash}-`;
  const primaryKey = `${prefix}${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  env.GIT_COMMIT = source;
  env.OPENCLAW_BUILD_TIMESTAMP = "2026-11-06T00:01:00.000Z";
  mkdirSync(probe, { recursive: true });
  if (phase === "prepare") {
    require(source === env.GITHUB_SHA &&
      !run("git", [
        "status",
        "--porcelain",
      ]), "Proof source must be clean and exactly the immutable dispatch HEAD");
    const producerRunId = env.PRODUCER_RUN_ID ?? "";
    require(producerRunId === "" || /^\d+$/.test(producerRunId), "Invalid producer run ID");
    let producerRun = null;
    if (producerRunId) {
      producerRun = api(`actions/runs/${producerRunId}`);
      require(producerRunId !== env.GITHUB_RUN_ID &&
        producerRun.head_sha === source &&
        producerRun.event === "workflow_dispatch" &&
        producerRun.status === "completed" &&
        producerRun.conclusion === "success" &&
        producerRun.run_attempt === 1 &&
        producerRun.path === workflowPath &&
        producerRun.head_branch ===
          env.GITHUB_REF_NAME, "Producer must be a distinct successful first dispatch of this exact proof HEAD");
    }
    const contract = {
      ...sourceGuard(),
      source,
      xcode,
      xcodeHash,
      gatewayVersion,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      ref: env.GITHUB_REF,
      role: producerRunId ? "consumer" : "producer",
      runnerName: env.RUNNER_NAME,
      runnerOS: env.RUNNER_OS,
      runnerArch: env.RUNNER_ARCH,
      macOS: run("sw_vers", ["-productVersion"]),
      swift: run("xcrun", ["swift", "--version"]),
      producerRunId,
      producerRun,
      primaryKey,
      prefix,
      revision: sample,
      buildNumber: 100 + sample,
      buildTimestamp: env.OPENCLAW_BUILD_TIMESTAMP,
      acceptance: {
        cache:
          "Cold miss; warm prefix restores exactly the producer saved key on a distinct fresh runner",
        replay:
          "Cold shared-module misses without hits; warm positive hits in all three shared modules",
        correctness:
          "Strict signed IPA metadata/UUID/entitlement validation, exact executable comparison, semantic resources, all six corruption controls",
        benefit: "warm wrapper + warm restore + warm save + cold producer save < cold wrapper",
      },
      limitation:
        "One cold producer and one fresh-runner consumer; Actions step durations have one-second precision",
    };
    json(contractFile, contract);
    console.log(JSON.stringify({ source, role: contract.role, primaryKey, producerRunId }));
  } else if (phase === "archive") {
    const contract = load(contractFile);
    require(source === contract.source && xcode === contract.xcode, "Prepared inputs changed");
    require(!run("git", ["status", "--porcelain"]), "Source changed before archive");
    const cacheDir = path.join(env.RUNNER_TEMP, "openclaw-ios-release-cas");
    require(env.OPENCLAW_IOS_COMPILATION_CACHE_DIR ===
      cacheDir, "Use the exact production CAS environment");
    require(!Object.keys(env).some((key) =>
      key.startsWith("OPENCLAW_IOS_ARCHIVE_PROBE_"),
    ), "Temporary archive instrumentation must not affect this production-path proof");
    const matchedKey = env.CACHE_MATCHED_KEY ?? "";
    require(env.CACHE_PRIMARY_KEY === primaryKey &&
      env.CACHE_HIT !== "true", "The per-run primary key must be new so production save executes");
    const casFiles = existsSync(cacheDir) ? walk(cacheDir).length : 0;
    require(contract.role === "producer"
      ? !matchedKey && casFiles === 0
      : matchedKey === `${prefix}${contract.producerRunId}-1` &&
          casFiles > 0, "Cold miss or exact producer prefix-restore prerequisite failed");
    const derivedRoot = path.join(homedir(), "Library/Developer/Xcode/DerivedData");
    const derivedEntries = existsSync(derivedRoot)
      ? readdirSync(derivedRoot)
          .filter((name) => name.startsWith("OpenClaw-"))
          .flatMap((name) =>
            readdirSync(path.join(derivedRoot, name)).map((entry) => `${name}/${entry}`),
          )
      : [];
    require(derivedEntries.every((entry) =>
      entry.endsWith("/SourcePackages"),
    ), "Fresh runner contains prior OpenClaw DerivedData build products");
    mkdirSync(caseDir);
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
      role: contract.role,
      source,
      xcode,
      gatewayVersion,
      revision: sample,
      buildNumber: 100 + sample,
      buildTimestamp: env.OPENCLAW_BUILD_TIMESTAMP,
      command,
      freshDerivedData: true,
      derivedEntries,
      casFilesBefore: casFiles,
      cachePrimaryKey: primaryKey,
      cacheMatchedKey: matchedKey,
      cacheHit: env.CACHE_HIT ?? "",
      runId: env.GITHUB_RUN_ID,
      runnerName: env.RUNNER_NAME,
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
      metadata.observedWallSeconds = (performance.now() - start) / 1000;
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
    const replay = {};
    for (const match of readFileSync(logFile, "utf8").matchAll(
      /note: Replay cache (hit|miss) \(in target '([^']+)'/g,
    )) {
      const counts = (replay[match[2]] ??= { hit: 0, miss: 0 });
      counts[match[1]]++;
    }
    const output = path.join(root, "apps/ios/build/app-store", `OpenClaw-${gatewayVersion}`);
    const ipa = `${output}.ipa`;
    const { payload } = payloadManifest(ipa, caseDir, `${output}.xcarchive`);
    json(path.join(caseDir, "summary.json"), {
      ...metadata,
      wallSeconds: time.real,
      time,
      replay,
      payload,
      ipaSha256: sha(readFileSync(ipa)),
    });
    console.log(JSON.stringify({ role: contract.role, time, replay }));
  } else {
    const contract = load(contractFile);
    const summary = load(path.join(caseDir, "summary.json"));
    const jobs = api(`actions/runs/${env.GITHUB_RUN_ID}/jobs?per_page=100`);
    json(path.join(probe, "jobs-at-report.json"), jobs);
    const job = jobs.jobs.find((entry) => entry.name === "archive-cache-transport");
    require(job, "Current transport job missing from Actions API");
    function duration(name) {
      const step = job.steps.find((entry) => entry.name === name);
      require(step?.status === "completed" &&
        step.conclusion === "success" &&
        step.started_at &&
        step.completed_at, `Cache step did not complete successfully: ${name}`);
      return {
        seconds: (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000,
        startedAt: step.started_at,
        completedAt: step.completed_at,
        conclusion: step.conclusion,
      };
    }
    const transfers = {
      restore: duration("Restore iOS release compilation cache"),
      save: duration("Save iOS release compilation cache"),
    };
    const caches = api(
      `actions/caches?key=${encodeURIComponent(primaryKey)}&ref=${encodeURIComponent(env.GITHUB_REF)}`,
    );
    json(path.join(probe, "cache-at-report.json"), caches);
    const cache = caches.actions_caches.find(
      (entry) => entry.key === primaryKey && entry.ref === env.GITHUB_REF,
    );
    require(cache?.size_in_bytes >
      0, "Production cache save did not publish a nonempty compressed cache");
    const targets = ["OpenClawProtocol", "OpenClawKit", "OpenClawChatUI"];
    const report = {
      contract,
      summary,
      transfers,
      compressedCache: {
        key: cache.key,
        id: cache.id,
        sizeBytes: cache.size_in_bytes,
        ref: cache.ref,
      },
      checks: {
        source: summary.source === contract.source && summary.xcode === contract.xcode,
        freshDerivedData: summary.freshDerivedData,
        sharedModules: targets.every((target) =>
          contract.role === "producer"
            ? summary.replay[target]?.miss > 0 && summary.replay[target]?.hit === 0
            : summary.replay[target]?.hit > 0,
        ),
      },
    };
    if (contract.role === "consumer") {
      const producer = path.join(env.RUNNER_TEMP, "ios-cas-producer");
      const previous = load(path.join(producer, "report.json"));
      require(previous.accepted &&
        previous.contract.role === "producer" &&
        previous.contract.runId === contract.producerRunId &&
        previous.contract.source === source &&
        previous.compressedCache.key ===
          summary.cacheMatchedKey, "Producer artifact is not the successful exact source/cache origin");
      run(
        "python3",
        [
          "-B",
          "scripts/ios-archive-cache-compare.py",
          path.join(producer, "case"),
          caseDir,
          "--output",
          path.join(probe, "comparison.json"),
          "--negative-controls",
        ],
        { stdio: "inherit" },
      );
      report.comparison = load(path.join(probe, "comparison.json"));
      report.producer = {
        contract: previous.contract,
        transfers: previous.transfers,
        compressedCache: previous.compressedCache,
        wallSeconds: previous.summary.wallSeconds,
      };
      const metadata = [
        "source",
        "xcode",
        "gatewayVersion",
        "revision",
        "buildNumber",
        "buildTimestamp",
      ];
      report.checks.sameInputs =
        metadata.every((field) => equal(summary[field], previous.summary[field])) &&
        ["macOS", "swift", "runnerOS", "runnerArch"].every((field) =>
          equal(contract[field], previous.contract[field]),
        );
      report.checks.distinctRun = contract.runId !== previous.contract.runId;
      report.checks.prefixReplay =
        summary.cacheMatchedKey === previous.compressedCache.key &&
        summary.cachePrimaryKey !== summary.cacheMatchedKey;
      report.checks.semanticComparison =
        report.comparison.accepted && report.comparison.negativeControlsPassed === true;
      report.accounting = {
        coldWrapperSeconds: previous.summary.wallSeconds,
        warmWrapperSeconds: summary.wallSeconds,
        warmRestoreSeconds: transfers.restore.seconds,
        warmSaveSeconds: transfers.save.seconds,
        coldSaveSeconds: previous.transfers.save.seconds,
      };
      report.accounting.warmTotalSeconds =
        summary.wallSeconds +
        transfers.restore.seconds +
        transfers.save.seconds +
        previous.transfers.save.seconds;
      report.accounting.netSavedSeconds =
        previous.summary.wallSeconds - report.accounting.warmTotalSeconds;
      report.checks.conservativeBenefit = report.accounting.netSavedSeconds > 0;
    }
    report.accepted = Object.values(report.checks).every(Boolean);
    json(path.join(probe, "report.json"), report);
    console.log(
      JSON.stringify(
        {
          role: contract.role,
          accepted: report.accepted,
          checks: report.checks,
          transfers,
          compressedCache: report.compressedCache,
          accounting: report.accounting,
        },
        null,
        2,
      ),
    );
    require(report.accepted, "Prospective production transport proof failed; original report retained");
  }
}
