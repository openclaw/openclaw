#!/usr/bin/env node
// Measures CLI startup memory with an isolated home and an in-process bench entry.
import { spawnSync as defaultSpawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const repoRoot = resolveRepoRoot(import.meta.url);
const tmpDir = process.env.TMPDIR || process.env.TEMP || process.env.TMP || os.tmpdir();
const MAX_RSS_MARKER = "__OPENCLAW_MAX_RSS_KB__=";
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const STARTUP_MEMORY_SAMPLE_COUNT = 3;
const STARTUP_MEMORY_RSS_TOLERANCE_MB = 1;
const COMMAND_TIMEOUT_MS = readPositiveIntEnv(
  "OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS",
  DEFAULT_COMMAND_TIMEOUT_MS,
);
let tmpHome = null;
let benchEntryPath = null;
const PASS = "pass";
const FAIL = "fail";
const REPORT_PATH_FILE_ERROR = "--json and --summary must refer to files";
const REPORT_PATH_CHANGED_ERROR = "--json or --summary changed during startup benchmarks";
const REPORT_PATH_ALIAS_ERROR = "--json and --summary must refer to different files";
function readPositiveIntEnv(name, fallback, env = process.env) {
  const value = readPositiveNumberEnv(name, fallback, env);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
function readPositiveNumberEnv(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const text = raw.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text)) {
    throw new Error(`${name} must be a positive number`);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}
function readNonEmptyEnv(name) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? null : value;
}
function readRequiredPathOption(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a path`);
  }
  return value;
}
function parseArgs(argv) {
  const options = {
    jsonPath:
      readNonEmptyEnv("OPENCLAW_STARTUP_MEMORY_JSON_PATH") ??
      path.join(repoRoot, ".artifacts", "startup-memory", "startup-memory.json"),
    summaryPath:
      readNonEmptyEnv("OPENCLAW_STARTUP_MEMORY_SUMMARY_PATH") ??
      path.join(repoRoot, ".artifacts", "startup-memory", "summary.md"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--json") {
      const value = readRequiredPathOption(argv, index, "--json");
      options.jsonPath = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--summary") {
      const value = readRequiredPathOption(argv, index, "--summary");
      options.summaryPath = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--help") {
      console.log(
        "Usage: node scripts/check-cli-startup-memory.mjs [--json <path>] [--summary <path>]",
      );
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}
const sameFsObject = (left, right) => left.dev === right.dev && left.ino === right.ino;
function createReportParents(filePath) {
  const parentPath = path.dirname(filePath);
  const firstCreated = mkdirSync(parentPath, { recursive: true });
  if (!firstCreated) {
    return [];
  }
  const created = [];
  for (let current = parentPath; ; current = path.dirname(current)) {
    created.push({ identity: lstatSync(current, { bigint: true }), path: current });
    if (current === firstCreated) {
      return created;
    }
  }
}
function resolveReportLeaf(filePath, unresolvedLinks = new Set()) {
  const physicalParent = realpathSync.native(path.dirname(filePath));
  const leafPath = path.join(physicalParent, path.basename(filePath));
  const identity = lstatSync(leafPath, { bigint: true, throwIfNoEntry: false });
  if (!identity?.isSymbolicLink()) {
    return leafPath;
  }
  if (unresolvedLinks.has(leafPath)) {
    throw Object.assign(new Error("Symlink cycle while resolving report path"), { code: "ELOOP" });
  }
  unresolvedLinks.add(leafPath);
  const target = readlinkSync(leafPath);
  const lastComponent = target.slice(target.lastIndexOf(path.sep) + 1);
  if (lastComponent === "" || lastComponent === "." || lastComponent === "..") {
    throw new Error(REPORT_PATH_FILE_ERROR);
  }
  return resolveReportLeaf(
    path.isAbsolute(target) ? target : `${physicalParent}${path.sep}${target}`,
    unresolvedLinks,
  );
}
function openReport(requestedPath) {
  const resolvedPath = resolveReportLeaf(requestedPath);
  let created = false;
  let fd;
  try {
    fd = openSync(
      resolvedPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
      0o600,
    );
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    fd = openSync(resolvedPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  }
  const identity = fstatSync(fd, { bigint: true });
  if (!identity.isFile()) {
    closeSync(fd);
    throw new Error(REPORT_PATH_FILE_ERROR);
  }
  return { created, fd, identity, path: resolvedPath, requestedPath };
}
function assertReportReservation(report) {
  if (sameFsObject(report.identity, statSync(report.requestedPath, { bigint: true }))) {
    return;
  }
  throw new Error(REPORT_PATH_CHANGED_ERROR);
}
function cleanupReservation({ reports, parents }) {
  for (const report of reports.toReversed()) {
    try {
      if (!report.created) {
        continue;
      }
      const current = lstatSync(report.path, { bigint: true, throwIfNoEntry: false });
      if (current?.isFile() && sameFsObject(report.identity, current)) {
        unlinkSync(report.path);
      }
    } catch {}
  }
  const deepestFirst = parents.toSorted(
    (left, right) => right.path.split(path.sep).length - left.path.split(path.sep).length,
  );
  for (const parent of deepestFirst) {
    try {
      const current = lstatSync(parent.path, { bigint: true, throwIfNoEntry: false });
      if (current?.isDirectory() && sameFsObject(parent.identity, current)) {
        rmdirSync(parent.path);
      }
    } catch {}
  }
}
function closeReports(reports, index = reports.length - 1) {
  if (index < 0) {
    return;
  }
  try {
    closeSync(reports[index].fd);
  } finally {
    closeReports(reports, index - 1);
  }
}
function reserveReports(options) {
  const parents = [];
  const reports = [];
  try {
    for (const filePath of [options.jsonPath, options.summaryPath]) {
      parents.push(...createReportParents(filePath));
    }
    reports.push(openReport(options.jsonPath));
    reports.push(openReport(options.summaryPath));
    reports.forEach(assertReportReservation);
    if (sameFsObject(reports[0].identity, reports[1].identity)) {
      throw new Error(REPORT_PATH_ALIAS_ERROR);
    }
    return { parents, reports };
  } catch (error) {
    try {
      closeReports(reports);
    } catch {}
    cleanupReservation({ parents, reports });
    throw error;
  }
}
function resolveDefaultLimitsMb(platform = process.platform) {
  return {
    // Linux CI is the tight startup regression signal. macOS consistently reports
    // higher RSS for the same launcher path, so keep it supported without hiding
    // Linux help-path regressions.
    help: platform === "darwin" ? 300 : 100,
    // Plugin discovery is heavier than help, but must stay below the doctor/channel
    // runtime graph that an empty metadata-only invocation must not import.
    pluginsList: platform === "darwin" ? 500 : 400,
    // Node 24 status startup reaches ~430 MB on current Linux runner images;
    // retain useful regression headroom without failing on allocator variance.
    statusJson: 450,
    gatewayStatus: 500,
  };
}
const DEFAULT_LIMITS_MB = resolveDefaultLimitsMb();
const cases = [
  {
    id: "help",
    label: "--help",
    args: ["openclaw.mjs", "--help"],
    limitMb: readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", DEFAULT_LIMITS_MB.help),
  },
  {
    id: "pluginsList",
    label: "plugins list --json",
    args: ["openclaw.mjs", "plugins", "list", "--json"],
    limitMb: readPositiveNumberEnv(
      "OPENCLAW_STARTUP_MEMORY_PLUGINS_LIST_MB",
      DEFAULT_LIMITS_MB.pluginsList,
    ),
  },
  {
    id: "statusJson",
    label: "status --json",
    args: ["openclaw.mjs", "status", "--json"],
    limitMb: readPositiveNumberEnv(
      "OPENCLAW_STARTUP_MEMORY_STATUS_JSON_MB",
      DEFAULT_LIMITS_MB.statusJson,
    ),
  },
  {
    id: "gatewayStatus",
    label: "gateway status",
    args: ["openclaw.mjs", "gateway", "status"],
    limitMb: readPositiveNumberEnv(
      "OPENCLAW_STARTUP_MEMORY_GATEWAY_STATUS_MB",
      DEFAULT_LIMITS_MB.gatewayStatus,
    ),
  },
];
function formatFixGuidance(testCase, details) {
  const command = `node ${testCase.args.join(" ")}`;
  const guidance = [
    "[startup-memory] Fix guidance",
    `Case: ${testCase.label}`,
    `Command: ${command}`,
    "Next steps:",
    `1. Run \`${command}\` locally on the built tree.`,
    "2. If this is an RSS overage, compare the startup import graph against the last passing commit and look for newly eager imports, bootstrap side effects, or plugin loading on the command path.",
    "3. If this is a non-zero exit, inspect the first transitive import/config error in stderr and fix that root cause before re-checking memory.",
    "LLM prompt:",
    `"OpenClaw startup-memory CI failed for '${testCase.label}'. Analyze this failure, identify the first runtime/import side effect that makes startup heavier or broken, and propose the smallest safe patch. Failure output:\n${details}"`,
  ];
  return `${guidance.join("\n")}\n`;
}
function formatFailure(testCase, message, details = "") {
  const trimmedDetails = details.trim();
  const sections = [message];
  if (trimmedDetails) {
    sections.push(trimmedDetails);
  }
  sections.push(formatFixGuidance(testCase, trimmedDetails || message));
  return sections.join("\n\n");
}
function failResult(report, testCase, error, details = "") {
  return {
    ...report,
    status: FAIL,
    error,
    failureMessage: formatFailure(testCase, error, details),
  };
}
function parseMaxRssMb(stderr) {
  const matches = [...stderr.matchAll(new RegExp(`^${MAX_RSS_MARKER}(\\d+)\\s*$`, "gm"))];
  const lastMatch = matches.at(-1);
  if (!lastMatch) {
    return null;
  }
  const maxRssKb = Number(lastMatch[1]);
  return Number.isFinite(maxRssKb) && maxRssKb > 0 ? maxRssKb / 1024 : null;
}
function formatMb(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)} MB` : "n/a";
}
function formatCaseCommand(testCase) {
  return `node ${testCase.args.join(" ")}`;
}
function nodeImportSpecifierForPath(filePath) {
  return pathToFileURL(filePath).href;
}
function buildBenchEnv(homeDir = tmpHome) {
  if (!homeDir) {
    throw new Error("temporary home is not initialized");
  }
  const env = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    XDG_CACHE_HOME: path.join(homeDir, ".cache"),
    PATH: process.env.PATH ?? "",
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: process.env.TERM ?? "dumb",
  };
  if (process.env.LC_ALL) {
    env.LC_ALL = process.env.LC_ALL;
  }
  if (process.env.CI) {
    env.CI = process.env.CI;
  }
  if (process.env.NODE_DISABLE_COMPILE_CACHE) {
    env.NODE_DISABLE_COMPILE_CACHE = process.env.NODE_DISABLE_COMPILE_CACHE;
  } else {
    // Keep the regression check focused on app/runtime startup, not Node's
    // one-shot compile cache overhead, which varies across runner builds.
    env.NODE_DISABLE_COMPILE_CACHE = "1";
  }
  // Keep the benchmark on a single process so RSS reflects the actual command
  // path rather than the warning-suppression respawn wrapper.
  env.OPENCLAW_NO_RESPAWN = "1";
  return env;
}
function runCaseSample(testCase, sampleIndex, params = {}) {
  if (!benchEntryPath) {
    throw new Error("bench entry path is not initialized");
  }
  if (!tmpHome) {
    throw new Error("temporary home is not initialized");
  }
  const sampleHome = path.join(tmpHome, "homes", `${testCase.id}-${sampleIndex + 1}`);
  mkdirSync(sampleHome, { recursive: true });
  const env = buildBenchEnv(sampleHome);
  const spawn = params.spawnSync ?? defaultSpawnSync;
  const timeoutMs = params.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const result = spawn(process.execPath, [benchEntryPath, ...testCase.args.slice(1)], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const stderr = String(result.stderr ?? "");
  const stdout = String(result.stdout ?? "");
  const maxRssMb = parseMaxRssMb(stderr);
  const matrixBootstrapWarning = /matrix: crypto runtime bootstrap failed/i.test(stderr);
  const report = {
    id: testCase.id,
    label: testCase.label,
    command: formatCaseCommand(testCase),
    limitMb: testCase.limitMb,
    rssToleranceMb: STARTUP_MEMORY_RSS_TOLERANCE_MB,
    effectiveLimitMb: testCase.limitMb + STARTUP_MEMORY_RSS_TOLERANCE_MB,
    maxRssMb,
    status: PASS,
    exitCode: result.status,
    signal: result.signal ?? null,
    error: null,
  };
  if (result.error) {
    const timedOut = result.error.code === "ETIMEDOUT";
    const error = timedOut
      ? `${testCase.label} timed out after ${timeoutMs}ms`
      : `${testCase.label} failed to start: ${result.error.message}`;
    return failResult(report, testCase, error, stderr.trim() || stdout);
  }
  if (result.status !== 0) {
    const exitDetail = result.status ?? result.signal ?? "unknown";
    const error = `${testCase.label} exited with ${String(exitDetail)}`;
    return failResult(report, testCase, error, stderr.trim() || stdout);
  }
  if (maxRssMb == null) {
    const error = `${testCase.label} did not report max RSS`;
    return failResult(report, testCase, error, stderr);
  }
  if (matrixBootstrapWarning) {
    const error = `${testCase.label} triggered Matrix crypto bootstrap during startup`;
    return failResult(report, testCase, error);
  }
  return report;
}
function median(values) {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = sorted.at(Math.floor(sorted.length / 2));
  if (middle === undefined) {
    throw new Error("cannot compute median of an empty sample set");
  }
  return middle;
}
function formatRssSamples(samplesMb) {
  return samplesMb.map((value) => value.toFixed(1)).join(", ");
}
function runCase(testCase, params = {}) {
  let report = runCaseSample(testCase, 0, params);
  if (report.status !== "pass" || report.maxRssMb == null) {
    return report;
  }
  const samples = [report.maxRssMb];
  // Shared CI runners occasionally produce a single allocator/RSS spike. Independent
  // homes plus a median keep that outlier from masking regressions; two high samples fail.
  for (let sampleIndex = 1; sampleIndex < STARTUP_MEMORY_SAMPLE_COUNT; sampleIndex += 1) {
    const sample = runCaseSample(testCase, sampleIndex, params);
    if (sample.status !== "pass" || sample.maxRssMb == null) {
      return sample;
    }
    samples.push(sample.maxRssMb);
    report = sample;
  }
  const maxRssMb = median(samples);
  const result = { ...report, maxRssMb, rssSamplesMb: samples };
  if (maxRssMb > result.effectiveLimitMb) {
    const error = `${testCase.label} median max RSS ${maxRssMb.toFixed(1)} MB exceeded effective ceiling ${result.effectiveLimitMb} MB (base limit ${result.limitMb} MB; RSS tolerance ${result.rssToleranceMb} MB; samples: ${formatRssSamples(samples)} MB)`;
    return failResult(result, testCase, error);
  }
  console.log(
    `[startup-memory] ${testCase.label}: ${maxRssMb.toFixed(1)} MB median max RSS ` +
      `(base limit ${result.limitMb} MB; RSS tolerance ${result.rssToleranceMb} MB; effective ceiling ${result.effectiveLimitMb} MB; samples ${formatRssSamples(samples)} MB)`,
  );
  return result;
}
function writeReport(reports, results) {
  const failed = results.filter((result) => result.status !== "pass");
  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    repoRoot,
    status: failed.length === 0 ? "pass" : "fail",
    results: results.map(({ failureMessage: _failureMessage, ...result }) => result),
  };
  const lines = [
    "# OpenClaw Startup Memory",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Status: ${report.status}`,
    "",
    ...results.map((result) => {
      const samples = result.rssSamplesMb
        ? `; samples: ${result.rssSamplesMb.map(formatMb).join(", ")}`
        : "";
      return `- ${result.label}: ${result.status} median max RSS ${formatMb(result.maxRssMb)} (base limit ${formatMb(result.limitMb)}; RSS tolerance ${formatMb(result.rssToleranceMb)}; effective ceiling ${formatMb(result.effectiveLimitMb)}${samples})`;
    }),
    "",
  ];
  if (failed.length > 0) {
    lines.push(
      "## Failures",
      "",
      ...failed.map((result) => `- ${result.label}: ${result.error ?? "unknown failure"}`),
      "",
    );
  }
  for (const [reservation, contents] of [
    [reports[0], `${JSON.stringify(report, null, 2)}\n`],
    [reports[1], `${lines.join("\n")}\n`],
  ]) {
    assertReportReservation(reservation);
    ftruncateSync(reservation.fd, 0);
    writeFileSync(reservation.fd, contents, "utf8");
    assertReportReservation(reservation);
  }
  reports.forEach(assertReportReservation);
}
function runStartupMemoryCheck(argv = process.argv.slice(2), params = {}) {
  const platform = params.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    console.log(`[startup-memory] Skipping on unsupported platform: ${platform}`);
    return { skipped: true, results: [] };
  }
  const options = parseArgs(argv);
  const reservation = reserveReports(options);
  const results = [];
  let operationError;
  let published = false;
  let outcome;
  try {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "openclaw-startup-memory-"));
    benchEntryPath = path.join(tmpHome, "bench-entry.mjs");
    // Run the real launcher in-process so peak RSS is self-reported at exit
    // without --import/--require flags: the entry declines its dist ESM resolve
    // fast path when preload hooks may be registered, so an injected hook would
    // measure a slower non-default resolution configuration instead of what a
    // plain `node openclaw.mjs ...` invocation pays.
    const launcherPath = path.join(repoRoot, "openclaw.mjs");
    writeFileSync(
      benchEntryPath,
      [
        "process.on('exit', () => {",
        "  const usage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;",
        `  if (usage && typeof usage.maxRSS === 'number') console.error('${MAX_RSS_MARKER}' + String(usage.maxRSS));`,
        "});",
        `const launcherPath = ${JSON.stringify(launcherPath)};`,
        "// The launcher and entry expect argv[1] to be the launcher path itself.",
        "process.argv[1] = launcherPath;",
        `await import(${JSON.stringify(nodeImportSpecifierForPath(launcherPath))});`,
        "",
      ].join("\n"),
      "utf8",
    );
    for (const testCase of cases) {
      results.push(runCase(testCase, params));
    }
    writeReport(reservation.reports, results);
    published = true;
    const failure = results.find((result) => result.status !== "pass");
    if (failure?.failureMessage) {
      throw new Error(failure.failureMessage);
    }
    outcome = { skipped: false, results };
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try {
    closeReports(reservation.reports);
  } catch (error) {
    cleanupError = error;
  }
  if (!published) {
    cleanupReservation(reservation);
  }
  if (tmpHome) {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    } finally {
      tmpHome = null;
      benchEntryPath = null;
    }
  }
  if (operationError !== undefined) {
    throw operationError instanceof Error
      ? operationError
      : new Error("startup memory check failed", { cause: operationError });
  }
  if (cleanupError !== undefined) {
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error("startup memory cleanup failed", { cause: cleanupError });
  }
  return outcome;
}
/**
 * Test-only access to pure startup memory helper functions.
 */
export const testing = {
  cases,
  parseArgs,
  readPositiveIntEnv,
  readPositiveNumberEnv,
  repoRoot,
  resolveDefaultLimitsMb,
  runStartupMemoryCheck,
  sampleCount: STARTUP_MEMORY_SAMPLE_COUNT,
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runStartupMemoryCheck();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
