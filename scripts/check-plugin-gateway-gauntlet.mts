#!/usr/bin/env node

// Runs plugin lifecycle and gateway QA gauntlet probes with timing metrics.
import type { StdioOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "../packages/normalization-core/src/number-coercion.ts";
import { normalizeCsvOrLooseStringList } from "../packages/normalization-core/src/string-normalization.ts";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mts";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import {
  parseNonNegativeInt,
  parsePositiveInt,
  parsePositiveNumber,
} from "./lib/numeric-options.mjs";
import {
  buildGauntletPrebuildEnv,
  collectGatewayCpuObservations,
  collectMetricObservations,
  collectPluginsWithRequiredEntries,
  collectRequiredPluginEntries,
  collectQaBaselineRegressionObservations,
  detectCommandDiagnosticFailure,
  discoverBundledPluginManifests,
  readQaSuiteSummary,
  selectPluginEntries,
} from "./lib/plugin-gateway-gauntlet.mts";
// Termination tests import this entrypoint in a child before publishing readiness.
// Keep its record guard on the dependency-light script seam to avoid startup skew.
import { isRecord } from "./lib/record-shared.mjs";

const DEFAULT_QA_SCENARIOS = [
  "channel-chat-baseline",
  "memory-failure-fallback",
  "gateway-restart-inflight-run",
];
const DEFAULT_CPU_CORE_WARN = 0.9;
const DEFAULT_HOT_WALL_WARN_MS = 30_000;
const DEFAULT_MAX_RSS_WARN_MB = 1536;
const DEFAULT_QA_PLUGIN_CHUNK_SIZE = 12;
const NUMERIC_FLAGS = {
  "--build-timeout-ms": ["buildTimeoutMs", parsePositiveInt],
  "--command-timeout-ms": ["commandTimeoutMs", parsePositiveInt],
  "--cpu-core-warn": ["cpuCoreWarn", parsePositiveNumber],
  "--hot-wall-warn-ms": ["hotWallWarnMs", parsePositiveInt],
  "--limit": ["limit", parsePositiveInt],
  "--max-rss-warn-mb": ["maxRssWarnMb", parsePositiveNumber],
  "--qa-cpu-regression-multiplier": ["qaCpuRegressionMultiplier", parsePositiveNumber],
  "--qa-plugin-chunk-size": ["qaPluginChunkSize", parsePositiveInt],
  "--qa-timeout-ms": ["qaTimeoutMs", parsePositiveInt],
  "--qa-wall-regression-multiplier": ["qaWallRegressionMultiplier", parsePositiveNumber],
  "--rss-anomaly-multiplier": ["rssAnomalyMultiplier", parsePositiveNumber],
  "--shard-index": ["shardIndex", parseNonNegativeInt],
  "--shard-total": ["shardTotal", parsePositiveInt],
  "--wall-anomaly-multiplier": ["wallAnomalyMultiplier", parsePositiveNumber],
} as const;
const SINGLE_VALUE_FLAGS = new Set([...Object.keys(NUMERIC_FLAGS), "--output-dir", "--repo-root"]);
const COMMAND_OUTPUT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const ANSI_PATTERN = new RegExp(String.raw`\u001B\[[0-9;]*m`, "gu");

type ProcessSignal = `SIG${string}`;
type PluginEntry = ReturnType<typeof discoverBundledPluginManifests>[number];
type CommandAlias = PluginEntry["cliCommandAliases"][number];
export type GauntletMeasuredRow = {
  label: string;
  phase: string;
  pluginId: string | null;
  status: number;
  diagnosticFailure: string | null;
  diagnosticDetail?: string;
  signal: ProcessSignal | null;
  timedOut: boolean;
  spawnError: { code: string | null; message: string } | null;
  logPath: string | null;
  logWriteError?: string;
  qaSummaryPath?: string;
  qaMetrics?: unknown;
} & ReturnType<typeof parseTimedMetrics>;
export type GauntletMeasuredCommandParams = {
  args: string[];
  command: string;
  consoleOutputMaxBytes?: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
  logDir: string;
  maxBufferBytes?: number;
  phase: string;
  pluginId?: string;
  spawnOptions?: { stdio?: StdioOptions };
  timeoutKillGraceMs?: number;
  timeoutMs: number;
  timeMode?: "none";
};
type GauntletObservation = Record<string, unknown> & {
  coldStart?: boolean;
  kind?: string;
  phase?: string;
};
type GauntletContext = {
  repoRoot: string;
  outputDir: string;
  env: NodeJS.ProcessEnv;
  matrix: PluginEntry[];
  plugins: PluginEntry[];
  rows: GauntletMeasuredRow[];
  commandTimeoutMs: number;
  skipSlashHelp: boolean;
  includePluginOwnedCliAliases: boolean;
  qaBaseline: boolean;
  qaScenarios: string[];
  qaPluginChunkSize: number;
  qaTimeoutMs: number;
};
type QaSummary = NonNullable<ReturnType<typeof readQaSuiteSummary>["summary"]>;

export function parseArgs(argv: string[]) {
  const args = stripLeadingPackageManagerSeparator(argv);
  const pluginIds: string[] = [];
  const qaScenarios: string[] = [];
  const options = {
    repoRoot: process.cwd(),
    outputDir: path.join(
      process.cwd(),
      ".artifacts",
      "plugin-gateway-gauntlet",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
    pluginIds,
    shardTotal: readOptionalPositiveIntEnv("OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_TOTAL") ?? 1,
    shardIndex: readOptionalNonNegativeIntEnv("OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_INDEX") ?? 0,
    limit: undefined as number | undefined,
    skipPrebuild: false,
    skipLifecycle: false,
    skipQa: false,
    qaBaseline: false,
    skipSlashHelp: false,
    qaScenarios,
    qaPluginChunkSize: DEFAULT_QA_PLUGIN_CHUNK_SIZE,
    cpuCoreWarn: DEFAULT_CPU_CORE_WARN,
    hotWallWarnMs: DEFAULT_HOT_WALL_WARN_MS,
    maxRssWarnMb: DEFAULT_MAX_RSS_WARN_MB,
    wallAnomalyMultiplier: 3,
    rssAnomalyMultiplier: 2.5,
    qaCpuRegressionMultiplier: 2,
    qaWallRegressionMultiplier: 2,
    commandTimeoutMs: 120_000,
    buildTimeoutMs: 600_000,
    qaTimeoutMs: 900_000,
    allowEmpty: false,
    failOnObservation: process.env.OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_FAIL_ON_OBSERVATION === "1",
    keepRunRoot: process.env.OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_KEEP_RUN_ROOT === "1",
  };
  const envIds = normalizeCsvOrLooseStringList(process.env.OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_IDS);
  options.pluginIds.push(...envIds);
  const numericFlags = Object.entries(NUMERIC_FLAGS);
  const seenSingleValueFlags = new Set<string>();
  parseArgv: for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      break;
    }
    if (SINGLE_VALUE_FLAGS.has(arg)) {
      if (seenSingleValueFlags.has(arg)) {
        throw new Error(`${arg} was provided more than once`);
      }
      seenSingleValueFlags.add(arg);
    }
    const readValue = () => {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    const numericFlag = numericFlags.find(([flag]) => flag === arg);
    if (numericFlag) {
      const [, [key, parse]] = numericFlag;
      options[key] = parse(readValue(), arg);
      continue;
    }
    switch (arg) {
      case "--":
        break parseArgv;
      case "--repo-root":
        options.repoRoot = path.resolve(readValue());
        break;
      case "--output-dir":
        options.outputDir = path.resolve(readValue());
        break;
      case "--plugin":
        options.pluginIds.push(readValue());
        break;
      case "--qa-scenario":
        options.qaScenarios.push(readValue());
        break;
      case "--qa-baseline":
        options.qaBaseline = true;
        break;
      case "--skip-prebuild":
        options.skipPrebuild = true;
        break;
      case "--skip-lifecycle":
        options.skipLifecycle = true;
        break;
      case "--skip-qa":
        options.skipQa = true;
        break;
      case "--skip-slash-help":
        options.skipSlashHelp = true;
        break;
      case "--keep-run-root":
        options.keepRunRoot = true;
        break;
      case "--allow-empty":
        options.allowEmpty = true;
        break;
      case "--fail-on-observation":
        options.failOnObservation = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.qaScenarios.length === 0) {
    options.qaScenarios = [...DEFAULT_QA_SCENARIOS];
  }
  assertNoDuplicateValues(options.pluginIds, "--plugin");
  assertNoDuplicateValues(options.qaScenarios, "--qa-scenario");
  return options;
}

function printHelp() {
  console.log(`Usage: pnpm test:plugins:gateway-gauntlet [options]

Runs a shardable bundled-plugin lifecycle, slash inventory, and QA gateway perf gauntlet.

Options:
  --plugin <id>                  Plugin id to include, repeatable
  --shard-total <count>          Total plugin shards (default: env or 1)
  --shard-index <index>          Zero-based shard index (default: env or 0)
  --limit <count>                Limit selected plugins after sharding
  --output-dir <path>            Artifact directory
  --qa-scenario <id>             QA Lab scenario id, repeatable
  --qa-plugin-chunk-size <count> Plugins enabled per QA run (default: 12)
  --qa-baseline                  Run a no-extra-plugin QA baseline before plugin chunks
  --cpu-core-warn <ratio>        Hot CPU threshold (default: 0.9)
  --hot-wall-warn-ms <ms>        Minimum wall time for hot CPU observations (default: 30000)
  --max-rss-warn-mb <mb>         Maximum RSS warning threshold (default: 1536)
  --wall-anomaly-multiplier <n>  Wall-time anomaly multiplier (default: 3)
  --rss-anomaly-multiplier <n>   RSS anomaly multiplier (default: 2.5)
  --qa-cpu-regression-multiplier <n>  QA baseline CPU regression multiplier (default: 2)
  --qa-wall-regression-multiplier <n> QA baseline wall regression multiplier (default: 2)
  --command-timeout-ms <ms>      Lifecycle/slash command timeout (default: 120000)
  --build-timeout-ms <ms>        Prebuild command timeout (default: 600000)
  --qa-timeout-ms <ms>           QA chunk timeout (default: 900000)
  --skip-prebuild                Skip the upfront build used to avoid per-command rebuild noise
  --skip-lifecycle              Skip plugin install/inspect/disable/enable/doctor/uninstall
  --skip-qa                     Skip QA Lab RPC conversation runs
  --skip-slash-help             Skip CLI help probes for plugin-declared command aliases
  --allow-empty                 Allow zero-command runs when every active phase is skipped
  --fail-on-observation         Treat RSS/CPU/wall observation rows as guard failures
  --keep-run-root               Preserve isolated HOME/state/log temp root after success

Environment:
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_IDS   Comma-separated plugin ids to include
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_TOTAL Total plugin shards
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_INDEX Zero-based shard index
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_FAIL_ON_OBSERVATION=1
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_KEEP_RUN_ROOT=1
  OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_QA_SUMMARY_MAX_BYTES  QA summary read ceiling
`);
}

function assertNoDuplicateValues(values: string[], label: string) {
  const seen = new Set();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      throw new Error(`Duplicate ${label} value: ${normalized}`);
    }
    seen.add(normalized);
  }
}

function readOptionalPositiveIntEnv(name: string) {
  const raw = process.env[name];
  return raw ? parsePositiveInt(raw, name) : undefined;
}

function readOptionalNonNegativeIntEnv(name: string) {
  const raw = process.env[name];
  return raw ? parseNonNegativeInt(raw, name) : undefined;
}

function shouldPromoteObservationGuardFailure(observation: GauntletObservation) {
  // Setup and the first cold work command are still reported, but they are not
  // stable enough to fail the gauntlet's steady-state regression guard.
  return observation?.phase !== "prebuild" && observation?.coldStart !== true;
}

export function buildObservationGuardFailures(
  observations: GauntletObservation[],
  enabled = false,
) {
  if (!enabled) {
    return [];
  }
  return observations.filter(shouldPromoteObservationGuardFailure).map((observation) => ({
    kind: `observation:${observation.kind ?? "unknown"}`,
    message: `Gauntlet observation threshold exceeded: ${observation.kind ?? "unknown"}`,
    observation,
  }));
}

export function createGauntletPrebuildCommand(repoRoot: string) {
  return {
    command: process.execPath,
    args: ["--import", "tsx", path.join(repoRoot, "scripts", "build-all.mts"), "qaRuntime"],
  };
}

function openclawCommand(repoRoot: string, args: string[]) {
  return {
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "entry.js"), ...args],
  };
}

function builtEntryPath(repoRoot: string) {
  return path.join(repoRoot, "dist", "entry.js");
}

function selectSlashHelpAliases(plugin: PluginEntry, includePluginOwnedCliAliases: boolean) {
  return includePluginOwnedCliAliases
    ? plugin.cliCommandAliases
    : plugin.cliCommandAliases.filter((entry) => !isPluginOwnedCliAlias(entry));
}

function requiresBuiltEntry(options: ReturnType<typeof parseArgs>, selectedPlugins: PluginEntry[]) {
  if (selectedPlugins.length === 0) {
    return false;
  }
  if (!options.skipLifecycle) {
    return true;
  }
  if (options.skipSlashHelp) {
    return false;
  }
  return selectedPlugins.some((plugin) => selectSlashHelpAliases(plugin, true).length > 0);
}

function sourceOpenclawCommand(repoRoot: string, args: string[]) {
  return {
    command: process.execPath,
    args: [path.join(repoRoot, "scripts", "run-node.mjs"), ...args],
  };
}

function chunkArray<Value>(values: Value[], chunkSize: number) {
  const chunks: Value[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

export function toRepoRelativePath(repoRoot: string, absolutePath: string) {
  const relativePath = path.relative(repoRoot, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Output path must stay inside repo root: ${absolutePath}`);
  }
  return relativePath;
}

function validateOutputDir(options: ReturnType<typeof parseArgs>, repoRoot: string) {
  if (!options.skipQa) {
    toRepoRelativePath(repoRoot, path.join(options.outputDir, "qa-suite"));
  }
}

function createIsolatedEnv(repoRoot: string, runRoot: string) {
  const home = path.join(runRoot, "home");
  const stateDir = path.join(runRoot, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ logging: { file: path.join(runRoot, "logs", "openclaw.log") } })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_QA_SUITE_PROGRESS: process.env.OPENCLAW_QA_SUITE_PROGRESS ?? "1",
    PATH: process.env.PATH,
    PWD: repoRoot,
  };
}

function timeWrapperArgs(command: string, args: string[]) {
  if (!fs.existsSync("/usr/bin/time")) {
    return { command, args, mode: "none" };
  }
  if (process.platform === "darwin") {
    return { command: "/usr/bin/time", args: ["-l", command, ...args], mode: "bsd" };
  }
  return { command: "/usr/bin/time", args: ["-v", command, ...args], mode: "gnu" };
}

export function parseTimedMetrics(stderr: string, wallMs: number, mode: string) {
  let userSeconds: number | null = null;
  let systemSeconds: number | null = null;
  let maxRssMb: number | null = null;
  if (mode === "gnu") {
    userSeconds = parseLastFloat(stderr, /^\s*User time \(seconds\):\s*([0-9.]+)\s*$/gmu);
    systemSeconds = parseLastFloat(stderr, /^\s*System time \(seconds\):\s*([0-9.]+)\s*$/gmu);
    const maxRssKb = parseLastFloat(
      stderr,
      /^\s*Maximum resident set size \(kbytes\):\s*([0-9.]+)\s*$/gmu,
    );
    maxRssMb = maxRssKb == null ? null : maxRssKb / 1024;
  } else if (mode === "bsd") {
    const cpuLine = parseLastMatch(
      stderr,
      /^\s*[0-9.]+\s+real\s+([0-9.]+)\s+user\s+([0-9.]+)\s+sys\s*$/gmu,
    );
    userSeconds = parseMatchFloat(cpuLine, 1);
    systemSeconds = parseMatchFloat(cpuLine, 2);
    const maxRssBytes = parseLastFloat(stderr, /^\s*([0-9]+)\s+maximum resident set size\s*$/gmu);
    maxRssMb = maxRssBytes == null ? null : maxRssBytes / 1024 / 1024;
  }
  const cpuMs =
    userSeconds == null && systemSeconds == null
      ? null
      : ((userSeconds ?? 0) + (systemSeconds ?? 0)) * 1000;
  return {
    wallMs,
    cpuMs,
    cpuCoreRatio: cpuMs == null || wallMs <= 0 ? null : cpuMs / wallMs,
    maxRssMb,
  };
}

function parseLastMatch(value: string, pattern: RegExp) {
  let lastMatch: RegExpMatchArray | null = null;
  for (const match of value.matchAll(pattern)) {
    lastMatch = match;
  }
  return lastMatch;
}

function parseMatchFloat(match: RegExpMatchArray | null, index: number) {
  if (!match) {
    return null;
  }
  const parsed = Number(match[index]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLastFloat(value: string, pattern: RegExp) {
  return parseMatchFloat(parseLastMatch(value, pattern), 1);
}

function stripAnsi(value: string) {
  return value.replace(ANSI_PATTERN, "");
}

function resolveOptionalTimerTimeoutMs(valueMs: number | undefined) {
  return valueMs === undefined || valueMs <= 0
    ? null
    : resolveTimerTimeoutMs(valueMs, MAX_TIMER_TIMEOUT_MS);
}

function writeCommandLog(params: {
  logDir: string;
  label: string;
  command: string[];
  stdout: string;
  stderr: string;
}) {
  const { logDir, label, stdout, stderr } = params;
  fs.mkdirSync(logDir, { recursive: true });
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]+/gu, "_");
  const logPath = path.join(logDir, `${safeLabel}.log`);
  fs.writeFileSync(
    logPath,
    [`$ ${params.command.join(" ")}`, "", stripAnsi(stdout), stripAnsi(stderr)].join("\n"),
    "utf8",
  );
  return logPath;
}

function boundedWriter(maxBytes: number, label: string, write: (text: string) => void) {
  let bytes = 0;
  let truncated = false;
  return (buffer: Buffer) => {
    if (truncated) {
      return;
    }
    const markTruncated = () => {
      write(`\n[${label} truncated after ${maxBytes} bytes]\n`);
      truncated = true;
    };
    const remainingBytes = maxBytes - bytes;
    if (remainingBytes <= 0) {
      markTruncated();
      return;
    }
    const captured = buffer.length > remainingBytes ? buffer.subarray(0, remainingBytes) : buffer;
    if (captured.length > 0) {
      write(captured.toString("utf8"));
    }
    bytes += captured.length;
    if (buffer.length > remainingBytes) {
      markTruncated();
    }
  };
}

export async function runMeasuredCommand(
  params: GauntletMeasuredCommandParams,
): Promise<GauntletMeasuredRow> {
  const { command, args, mode } =
    params.timeMode === "none"
      ? { command: params.command, args: params.args, mode: "none" }
      : timeWrapperArgs(params.command, params.args);
  const started = performance.now();
  let stdout = "";
  let stderr = "";
  let spawnError: GauntletMeasuredRow["spawnError"] = null;
  let timedOut = false;
  let exitStatus: number | null = null;
  let exitSignal: ProcessSignal | null = null;
  let parentTerminationSignal: NodeJS.Signals | undefined;
  let commandError: unknown;
  const maxBufferBytes = params.maxBufferBytes ?? COMMAND_OUTPUT_MAX_BUFFER_BYTES;
  const maxRelayBytes = params.consoleOutputMaxBytes ?? maxBufferBytes;
  const timeoutMs = resolveOptionalTimerTimeoutMs(params.timeoutMs);
  const timeoutKillGraceMs = resolveTimerTimeoutMs(
    params.timeoutKillGraceMs ?? 5_000,
    MAX_TIMER_TIMEOUT_MS,
  );
  const capture = {
    stdout: boundedWriter(maxBufferBytes, "stdout", (text) => {
      stdout += text;
    }),
    stderr: boundedWriter(maxBufferBytes, "stderr", (text) => {
      stderr += text;
    }),
  };
  const relay = {
    stdout: boundedWriter(maxRelayBytes, "stdout relay", (text) => process.stdout.write(text)),
    stderr: boundedWriter(maxRelayBytes, "stderr relay", (text) => process.stderr.write(text)),
  };
  const appendOutput = (streamName: "stdout" | "stderr", chunk: string | Uint8Array) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    relay[streamName](buffer);
    capture[streamName](buffer);
  };
  try {
    await runManagedCommand({
      bin: command,
      args,
      cwd: params.cwd,
      env: params.env,
      shell: false,
      stdio: (mode === "none" ? params.spawnOptions?.stdio : undefined) ?? "pipe",
      timeoutMs: timeoutMs ?? undefined,
      timeoutKillGraceMs,
      signalKillGraceMs: timeoutKillGraceMs,
      // Windows retains the managed owner's ordinary completion contract.
      requireProcessTreeExit: process.platform !== "win32",
      onSignal(signal) {
        parentTerminationSignal ??= signal;
      },
      onReady(child) {
        child.once("exit", (status, signal) => {
          exitStatus = status;
          exitSignal = signal;
        });
        child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
        child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));
      },
    });
  } catch (error) {
    commandError = error;
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : null;
    spawnError = {
      code,
      message: error instanceof Error ? error.message : String(error),
    };
    timedOut = code === "ETIMEDOUT";
  }
  if (parentTerminationSignal && !hasUnjoinedWork(commandError)) {
    // Preserve signal termination after cleanup, without admitting another probe.
    const terminationSignal = parentTerminationSignal;
    return await new Promise<never>(() => {
      process.kill(process.pid, terminationSignal);
    });
  }
  const wallMs = performance.now() - started;
  const finalStatus =
    spawnError && !timedOut ? 1 : (exitStatus ?? (exitSignal || spawnError ? 1 : 0));
  const finalStderr = [
    stderr,
    spawnError ? `[spawn error] ${spawnError.code ?? "unknown"} ${spawnError.message}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  let logPath: string | null = null;
  let logWriteError: string | null = null;
  try {
    logPath = writeCommandLog({
      logDir: params.logDir,
      label: params.label,
      command: [params.command, ...params.args],
      stdout,
      stderr: finalStderr,
    });
  } catch (error) {
    logWriteError = error instanceof Error ? error.message : String(error);
  }
  if (hasUnjoinedWork(commandError)) {
    throw commandError;
  }
  const outputDiagnosticFailure = detectCommandDiagnosticFailure(stdout, finalStderr);
  const diagnosticFailure =
    outputDiagnosticFailure ?? (logWriteError ? "command-log-write-failure" : null);
  return {
    label: params.label,
    phase: params.phase,
    pluginId: params.pluginId ?? null,
    status: logWriteError ? 1 : finalStatus,
    diagnosticFailure,
    signal: exitSignal,
    timedOut,
    spawnError,
    logPath,
    ...(logWriteError ? { logWriteError } : {}),
    ...parseTimedMetrics(finalStderr, wallMs, mode),
  };
}

export function hasGauntletWorkRows(rows: Array<Pick<GauntletMeasuredRow, "phase">>) {
  return rows.some((row) => row.phase !== "prebuild");
}

function isPluginOwnedCliAlias(alias: CommandAlias) {
  return alias.kind === "runtime-slash" && alias.cliCommand === alias.name;
}

function buildSlashHelpProbe(
  params: GauntletContext & {
    plugin: PluginEntry;
    alias: CommandAlias;
  },
) {
  const command = params.alias.cliCommand ?? params.alias.name;
  return {
    cwd: params.repoRoot,
    env: params.env,
    logDir: path.join(params.outputDir, "logs", "slash-help"),
    ...openclawCommand(params.repoRoot, [command, "--help"]),
    label: `${params.plugin.id}-slash-${params.alias.name}`,
    phase: "slash:help",
    pluginId: params.plugin.id,
    timeoutMs: params.commandTimeoutMs,
  };
}

async function runPluginLifecycleCommand(
  params: GauntletContext & {
    logPluginId: string;
    label: string;
    phase: string;
    args: string[];
    pluginId: string;
  },
) {
  process.stderr.write(`[plugin-gauntlet] ${params.logPluginId} ${params.phase}\n`);
  params.rows.push(
    await runMeasuredCommand({
      cwd: params.repoRoot,
      env: params.env,
      logDir: path.join(params.outputDir, "logs", "lifecycle"),
      ...openclawCommand(params.repoRoot, ["plugins", ...params.args]),
      label: params.label,
      phase: `lifecycle:${params.phase}`,
      pluginId: params.pluginId,
      timeoutMs: params.commandTimeoutMs,
    }),
  );
}

async function runPluginLifecycle(params: GauntletContext) {
  for (const plugin of params.plugins) {
    const requiredPlugins = collectRequiredPluginEntries(params.matrix, [plugin]);
    for (const requiredPlugin of requiredPlugins) {
      await runPluginLifecycleCommand({
        ...params,
        logPluginId: plugin.id,
        label: `${plugin.id}-requires-${requiredPlugin.id}-install`,
        phase: `requires:${requiredPlugin.id}:install`,
        args: ["install", requiredPlugin.id],
        pluginId: requiredPlugin.id,
      });
    }
    type LifecycleCommand =
      | { phase: string; args: string[] }
      | { phase: string; alias: CommandAlias };
    const commands = [
      {
        phase: "install",
        args: ["install", plugin.id],
      },
      { phase: "inspect", args: ["inspect", plugin.id, "--json"] },
      ...(params.skipSlashHelp
        ? []
        : plugin.cliCommandAliases
            .filter(isPluginOwnedCliAlias)
            .map((alias) => ({ phase: `slash-help:${alias.name}`, alias }))),
      { phase: "disable", args: ["disable", plugin.id] },
      ...(plugin.hasRequiredConfigFields ? [] : [{ phase: "enable", args: ["enable", plugin.id] }]),
      { phase: "doctor", args: ["doctor"] },
      { phase: "uninstall", args: ["uninstall", plugin.id, "--force"] },
    ] satisfies LifecycleCommand[];
    for (const command of commands) {
      if ("alias" in command) {
        process.stderr.write(`[plugin-gauntlet] ${plugin.id} ${command.phase}\n`);
        params.rows.push(
          await runMeasuredCommand({
            ...buildSlashHelpProbe({
              ...params,
              plugin,
              alias: command.alias,
            }),
            label: `${plugin.id}-${command.phase}`,
          }),
        );
        continue;
      }
      await runPluginLifecycleCommand({
        ...params,
        logPluginId: plugin.id,
        label: `${plugin.id}-${command.phase}`,
        phase: command.phase,
        args: command.args,
        pluginId: plugin.id,
      });
    }
    for (const requiredPlugin of requiredPlugins.toReversed()) {
      await runPluginLifecycleCommand({
        ...params,
        logPluginId: plugin.id,
        label: `${plugin.id}-requires-${requiredPlugin.id}-uninstall`,
        phase: `requires:${requiredPlugin.id}:uninstall`,
        args: ["uninstall", requiredPlugin.id, "--force"],
        pluginId: requiredPlugin.id,
      });
    }
  }
}

async function runSlashHelpProbes(params: GauntletContext) {
  for (const plugin of params.plugins) {
    const aliases = selectSlashHelpAliases(plugin, params.includePluginOwnedCliAliases);
    for (const alias of aliases) {
      process.stderr.write(`[plugin-gauntlet] ${plugin.id} slash-help /${alias.name}\n`);
      params.rows.push(await runMeasuredCommand(buildSlashHelpProbe({ ...params, plugin, alias })));
    }
  }
}

async function runQaChunks(params: GauntletContext) {
  const chunks = [
    ...(params.qaBaseline ? [{ label: "baseline", plugins: [] }] : []),
    ...chunkArray(params.plugins, params.qaPluginChunkSize).map((plugins, index) => ({
      label: `chunk-${String(index).padStart(2, "0")}`,
      plugins,
    })),
  ];
  const summaries: QaSummary[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const outputDir = path.join(params.outputDir, "qa-suite", chunk.label);
    const outputArg = toRepoRelativePath(params.repoRoot, outputDir);
    const pluginIds = chunk.plugins.map((plugin) => plugin.id);
    const enabledPluginIds = collectPluginsWithRequiredEntries(params.matrix, chunk.plugins).map(
      (plugin) => plugin.id,
    );
    const pluginIdLabel = pluginIds.length > 0 ? pluginIds.join(",") : "<baseline>";
    process.stderr.write(
      `[plugin-gauntlet] qa chunk ${index + 1}/${chunks.length}: ${pluginIdLabel}\n`,
    );
    const row = await runMeasuredCommand({
      cwd: params.repoRoot,
      env: params.env,
      logDir: path.join(params.outputDir, "logs", "qa-suite"),
      ...sourceOpenclawCommand(params.repoRoot, [
        "qa",
        "suite",
        "--provider-mode",
        "mock-openai",
        "--concurrency",
        "1",
        "--output-dir",
        outputArg,
        ...params.qaScenarios.flatMap((scenario) => ["--scenario", scenario]),
        ...enabledPluginIds.flatMap((pluginId) => ["--enable-plugin", pluginId]),
      ]),
      label: `qa-${chunk.label}`,
      phase: "qa:rpc",
      timeoutMs: params.qaTimeoutMs,
    });
    const summaryPath = path.join(outputDir, "qa-suite-summary.json");
    const qaSummaryResult = readQaSuiteSummary(summaryPath);
    const qaDiagnosticFailure =
      row.status === 0 && !row.timedOut ? qaSummaryResult.diagnosticFailure : null;
    params.rows.push({
      ...row,
      pluginId: pluginIdLabel,
      qaSummaryPath: summaryPath,
      ...(qaDiagnosticFailure ? { diagnosticFailure: qaDiagnosticFailure } : {}),
      ...(qaSummaryResult.diagnosticDetail
        ? { diagnosticDetail: qaSummaryResult.diagnosticDetail }
        : {}),
      ...(qaSummaryResult.summary?.metrics ? { qaMetrics: qaSummaryResult.summary.metrics } : {}),
    });
    if (qaSummaryResult.summary) {
      summaries.push(qaSummaryResult.summary);
    }
  }
  return summaries;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot);
  validateOutputDir(options, repoRoot);
  fs.mkdirSync(options.outputDir, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-gauntlet-"));
  let preserveRunRoot = options.keepRunRoot;
  try {
    const env = createIsolatedEnv(repoRoot, runRoot);
    const matrix = discoverBundledPluginManifests(repoRoot);
    const selectedPlugins = selectPluginEntries(matrix, {
      ids: options.pluginIds,
      shardTotal: options.shardTotal,
      shardIndex: options.shardIndex,
      limit: options.limit,
    });
    const selectedPluginsWithRequired = collectPluginsWithRequiredEntries(matrix, selectedPlugins);
    const rows: GauntletMeasuredRow[] = [];
    const commandEnv = buildGauntletPrebuildEnv(env, {
      includePrivateQa: !options.skipQa,
      buildIds: selectedPluginsWithRequired.map((plugin) => plugin.buildId),
      skipDeclarationBuild: true,
    });
    const context = {
      repoRoot,
      outputDir: options.outputDir,
      env: commandEnv,
      matrix,
      plugins: selectedPlugins,
      rows,
      commandTimeoutMs: options.commandTimeoutMs,
      skipSlashHelp: options.skipSlashHelp,
      includePluginOwnedCliAliases: options.skipLifecycle,
      qaBaseline: options.qaBaseline,
      qaScenarios: options.qaScenarios,
      qaPluginChunkSize: options.qaPluginChunkSize,
      qaTimeoutMs: options.qaTimeoutMs,
    };
    if (!options.skipPrebuild && (selectedPlugins.length > 0 || !options.skipQa)) {
      process.stderr.write("[plugin-gauntlet] prebuild\n");
      const prebuildCommand = createGauntletPrebuildCommand(repoRoot);
      rows.push(
        await runMeasuredCommand({
          cwd: repoRoot,
          env: commandEnv,
          logDir: path.join(options.outputDir, "logs", "prebuild"),
          command: prebuildCommand.command,
          args: prebuildCommand.args,
          label: "prebuild",
          phase: "prebuild",
          timeoutMs: options.buildTimeoutMs,
        }),
      );
    }
    const prebuildFailed = rows.some(
      (row) => row.phase === "prebuild" && (row.status !== 0 || row.timedOut),
    );
    const entryPath = builtEntryPath(repoRoot);
    const missingSkippedPrebuildEntry =
      selectedPlugins.length > 0 &&
      options.skipPrebuild &&
      requiresBuiltEntry(options, selectedPlugins) &&
      !fs.existsSync(entryPath);
    if (!prebuildFailed && !missingSkippedPrebuildEntry && !options.skipLifecycle) {
      await runPluginLifecycle(context);
    }
    if (!prebuildFailed && !missingSkippedPrebuildEntry && !options.skipSlashHelp) {
      await runSlashHelpProbes(context);
    }
    const qaSummaries = options.skipQa || prebuildFailed ? [] : await runQaChunks(context);
    const metricObservations = collectMetricObservations(rows, {
      cpuCoreWarn: options.cpuCoreWarn,
      hotWallWarnMs: options.hotWallWarnMs,
      maxRssWarnMb: options.maxRssWarnMb,
      wallAnomalyMultiplier: options.wallAnomalyMultiplier,
      rssAnomalyMultiplier: options.rssAnomalyMultiplier,
    });
    const qaBaselineObservations = collectQaBaselineRegressionObservations(rows, {
      cpuRegressionMultiplier: options.qaCpuRegressionMultiplier,
      wallRegressionMultiplier: options.qaWallRegressionMultiplier,
    });
    const gatewayObservations = qaSummaries.flatMap((qa) =>
      collectGatewayCpuObservations({
        startup: null,
        qa: isRecord(qa.metrics) ? { metrics: qa.metrics } : undefined,
        cpuCoreWarn: options.cpuCoreWarn,
        hotWallWarnMs: options.hotWallWarnMs,
      }),
    );
    const failures = rows.filter(
      (row) => row.status !== 0 || row.timedOut || row.diagnosticFailure,
    );
    const observations = [...metricObservations, ...qaBaselineObservations, ...gatewayObservations];
    const guardFailures: Array<{ kind: string; message: string }> = [];
    if (missingSkippedPrebuildEntry) {
      guardFailures.push({
        kind: "missing-built-entry",
        message:
          `${path.relative(repoRoot, entryPath)} is missing; ` +
          "run without --skip-prebuild or build the gauntlet runtime first.",
      });
    }
    if (!hasGauntletWorkRows(rows) && !options.allowEmpty && guardFailures.length === 0) {
      guardFailures.push({
        kind: "empty-run",
        message:
          "No lifecycle, slash-help, or QA gauntlet commands ran; remove a skip flag or pass --allow-empty for intentional dry runs.",
      });
    }
    guardFailures.push(...buildObservationGuardFailures(observations, options.failOnObservation));
    const hasFailures = failures.length > 0 || guardFailures.length > 0;
    preserveRunRoot = preserveRunRoot || hasFailures;
    let cleanupError = null;
    if (!preserveRunRoot) {
      try {
        fs.rmSync(runRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
        preserveRunRoot = true;
      }
    }
    const summary = {
      generatedAt: new Date().toISOString(),
      repoRoot,
      outputDir: options.outputDir,
      isolatedRunRoot: runRoot,
      isolatedRunRootPreserved: preserveRunRoot,
      isolatedRunRootCleanupError: cleanupError,
      selectedPluginCount: selectedPlugins.length,
      totalPluginCount: matrix.length,
      options: {
        pluginIds: options.pluginIds,
        shardTotal: options.shardTotal,
        shardIndex: options.shardIndex,
        limit: options.limit ?? null,
        qaScenarios: options.qaScenarios,
        qaPluginChunkSize: options.qaPluginChunkSize,
        qaBaseline: options.qaBaseline,
        allowEmpty: options.allowEmpty,
        failOnObservation: options.failOnObservation,
        keepRunRoot: options.keepRunRoot,
        skipLifecycle: options.skipLifecycle,
        skipQa: options.skipQa,
        skipSlashHelp: options.skipSlashHelp,
        skipPrebuild: options.skipPrebuild,
        thresholds: {
          cpuCoreWarn: options.cpuCoreWarn,
          hotWallWarnMs: options.hotWallWarnMs,
          maxRssWarnMb: options.maxRssWarnMb,
          wallAnomalyMultiplier: options.wallAnomalyMultiplier,
          rssAnomalyMultiplier: options.rssAnomalyMultiplier,
          qaCpuRegressionMultiplier: options.qaCpuRegressionMultiplier,
          qaWallRegressionMultiplier: options.qaWallRegressionMultiplier,
        },
      },
      matrix,
      selectedPlugins,
      rows,
      observations,
      failures,
      guardFailures,
    };
    const summaryPath = path.join(options.outputDir, "plugin-gateway-gauntlet-summary.json");
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    process.stdout.write(`[plugin-gauntlet] summary: ${summaryPath}\n`);
    process.stdout.write(
      `[plugin-gauntlet] plugins=${selectedPlugins.length}/${matrix.length} rows=${rows.length} failures=${failures.length} observations=${summary.observations.length}\n`,
    );
    if (preserveRunRoot) {
      process.stdout.write(`[plugin-gauntlet] isolated run root preserved: ${runRoot}\n`);
    }
    for (const failure of failures) {
      process.stdout.write(
        `[plugin-gauntlet] failure phase=${failure.phase} plugin=${failure.pluginId ?? "<none>"} status=${failure.status} timedOut=${failure.timedOut} diagnostic=${failure.diagnosticFailure ?? ""} wallMs=${Math.round(failure.wallMs)} log=${failure.logPath}\n`,
      );
    }
    for (const failure of guardFailures) {
      process.stdout.write(`[plugin-gauntlet] failure ${failure.kind}: ${failure.message}\n`);
    }
    for (const observation of summary.observations.slice(0, 20)) {
      process.stdout.write(`[plugin-gauntlet] observation ${JSON.stringify(observation)}\n`);
    }
    if (hasFailures) {
      process.exitCode = 1;
    }
  } catch (error) {
    const unjoined = hasUnjoinedWork(error);
    if (unjoined) {
      process.stderr.write(`[plugin-gauntlet] isolated run root preserved: ${runRoot}\n`);
    }
    if (!options.keepRunRoot && !unjoined) {
      try {
        fs.rmSync(runRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        process.stderr.write(
          `[plugin-gauntlet] failed to clean isolated run root ${runRoot}: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }\n`,
        );
      }
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
