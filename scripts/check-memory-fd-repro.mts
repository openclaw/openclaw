#!/usr/bin/env node

// Reproduces memory-search file descriptor retention with a synthetic workspace.
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { safeParseJson } from "../packages/normalization-core/src/json-coercion.ts";
import { resolveTimerTimeoutMs } from "../packages/normalization-core/src/number-coercion.ts";
import { asNullableRecord as asRecord } from "../packages/normalization-core/src/record-coerce.ts";
import { readNonBlankString } from "../packages/normalization-core/src/string-coerce.ts";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mts";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import { formatErrorMessage } from "./lib/error-format.mts";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import { parseStrictNonNegativeDecimal as parseNonNegativeInteger } from "./lib/numeric-options.mjs";

const ISSUE_FILE_COUNTS = [
  ["memory/transcripts", 9394],
  ["memory/transcripts.archived", 1695],
  ["memory/structured-md/lessons", 268],
  ["memory/structured-md/decisions", 215],
  ["memory/structured-md/lessons.archived", 214],
  ["memory/structured-md/procedures", 213],
  ["memory/structured-md/decisions.archived", 151],
  ["memory/structured-md/procedures.archived", 126],
  ["memory/structured-md/projects", 81],
  ["memory/structured-md/projects.archived", 34],
] satisfies Array<[string, number]>;

type ChildExitState = { exitCode: number | null; signalCode: string | null };
type GatewayReadyChild = ChildExitState & { pid?: number };
type GatewayReadyOutputState = { tail?: string; readySeen?: boolean };
type ConfigOptions = { homeDir: string; workspaceDir: string; port: number; token: string };
type FdSampleOptions = { label: string; pid: number; workspaceRealPath: string };
type GatewayReadyOptions = {
  child: GatewayReadyChild;
  port: number;
  logPath: string;
  timeoutMs: number;
  outputState?: GatewayReadyOutputState;
};
type InvokeOptions = { port: number; token: string; timeoutMs: number; signal?: AbortSignal };
type InvokeResponseOptions = { httpOk: boolean; status: number; bodyText: string };

const ISSUE_MEMORY_FILE_COUNT = ISSUE_FILE_COUNTS.reduce((sum, [, count]) => sum + count, 0);
const DEFAULT_FILE_COUNT = 512;
const DEFAULT_MAX_WORKSPACE_REG_FDS = process.platform === "darwin" ? 8 : 64;
/**
 * Maximum gateway-ready output tail retained while waiting for startup.
 */
const GATEWAY_READY_OUTPUT_MAX_CHARS = 128 * 1024;
/**
 * Maximum bytes read from the memory_search HTTP response.
 */
const MEMORY_SEARCH_RESPONSE_MAX_BYTES = 256 * 1024;
/**
 * Probe query expected to hit the synthetic top-level memory file.
 */
const MEMORY_SEARCH_PROBE_QUERY = "Top-level memory file";

const SKIP_GATEWAY_ENV = {
  NODE_ENV: "test",
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_SKIP_ACPX_RUNTIME: "1",
  OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
};

function usage() {
  return `
Usage: node --import tsx scripts/check-memory-fd-repro.mts [options]

Options:
  --full                         Use the issue-sized 12,391-file memory tree.
  --files <count>                Number of memory/**/*.md files to generate. Default: ${DEFAULT_FILE_COUNT}.
  --mode <fixed|leak|report>     fixed fails on FD fan-out; leak expects it; report skips threshold checks. Default: fixed.
  --max-workspace-reg-fds <n>    Fixed-mode maximum retained workspace Markdown REG FDs. Default: ${DEFAULT_MAX_WORKSPACE_REG_FDS}.
  --min-leaked-fds <n>           Leak-mode minimum retained workspace Markdown REG FDs. Default: min(files, 64).
  --invoke-timeout-ms <n>        Abort the memory_search HTTP call after this long. Default: 30000.
  --sample-delay-ms <n>          First post-invoke FD sample delay. Default: 1000.
  --settle-delay-ms <n>          Final FD sample delay after invoke settles. Default: 5000.
  --output-dir <path>            Artifact directory. Default: .artifacts/memory-fd-repro/<timestamp>.
  --keep                         Keep the synthetic OPENCLAW_HOME and workspace after the run.
  --allow-non-darwin             Run on non-macOS platforms. lsof REG counts are most meaningful on macOS.
  --help                         Show this help.
`.trim();
}

const ARGUMENT_FLAGS = new Set([
  "--allow-non-darwin",
  "--expect-leak",
  "--files",
  "--full",
  "--help",
  "--invoke-timeout-ms",
  "--keep",
  "--max-workspace-reg-fds",
  "--min-leaked-fds",
  "--mode",
  "--output-dir",
  "--report-only",
  "--sample-delay-ms",
  "--settle-delay-ms",
]);

function stripPackageManagerSeparatorForKnownFlags(argv: string[]) {
  return argv[0] === "--" && argv[1] !== undefined && ARGUMENT_FLAGS.has(argv[1])
    ? stripLeadingPackageManagerSeparator(argv)
    : argv;
}

/**
 * Parses a safe positive integer option.
 */
function readPositiveNumber(value: unknown, label: string) {
  const parsed = parseNonNegativeInteger(value, label);
  if (parsed <= 0) {
    throw new Error(`${label} must be greater than 0`);
  }
  return parsed;
}

function readNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : parseNonNegativeInteger(raw, name);
}

function readPositiveNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : readPositiveNumber(raw, name);
}

function readTimerTimeoutNumber(value: unknown, label: string, minMs = 1) {
  const parsed =
    minMs > 0 ? readPositiveNumber(value, label) : parseNonNegativeInteger(value, label);
  return resolveTimerTimeoutMs(parsed, minMs, minMs);
}

function readTimerTimeoutNumberEnv(name: string, fallback: number, minMs = 1) {
  const raw = process.env[name];
  return raw == null || raw.trim() === ""
    ? resolveTimerTimeoutMs(fallback, minMs, minMs)
    : readTimerTimeoutNumber(raw, name, minMs);
}

/**
 * Parses memory FD repro CLI arguments and environment fallbacks.
 */
export function parseArgs(argv: string[]) {
  const args = stripPackageManagerSeparatorForKnownFlags(argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let fileCount: number | undefined;
  let maxWorkspaceRegFds: number | undefined;
  let minLeakedFds: number | undefined;
  let invokeTimeoutMs: number | undefined;
  let sampleDelayMs: number | undefined;
  let settleDelayMs: number | undefined;
  let mode = process.env.OPENCLAW_MEMORY_FD_REPRO_MODE || "fixed";
  let outputDir = path.resolve(".artifacts", "memory-fd-repro", stamp);
  let keep = process.env.OPENCLAW_MEMORY_FD_REPRO_KEEP === "1";
  let allowNonDarwin = process.env.OPENCLAW_MEMORY_FD_REPRO_ALLOW_NON_DARWIN === "1";

  parseArgv: for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      break;
    }
    const next = args[i + 1];
    const readValue = () => {
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return next;
    };

    switch (arg) {
      case "--":
        break parseArgv;
      case "--help":
        console.log(usage());
        process.exit(0);
      case "--full":
        fileCount = ISSUE_MEMORY_FILE_COUNT;
        break;
      case "--files":
        fileCount = readPositiveNumber(readValue(), "--files");
        break;
      case "--mode":
        mode = readValue();
        break;
      case "--expect-leak":
        mode = "leak";
        break;
      case "--report-only":
        mode = "report";
        break;
      case "--max-workspace-reg-fds":
        maxWorkspaceRegFds = parseNonNegativeInteger(readValue(), "--max-workspace-reg-fds");
        break;
      case "--min-leaked-fds":
        minLeakedFds = readPositiveNumber(readValue(), "--min-leaked-fds");
        break;
      case "--invoke-timeout-ms":
        invokeTimeoutMs = readTimerTimeoutNumber(readValue(), "--invoke-timeout-ms");
        break;
      case "--sample-delay-ms":
        sampleDelayMs = readTimerTimeoutNumber(readValue(), "--sample-delay-ms", 0);
        break;
      case "--settle-delay-ms":
        settleDelayMs = readTimerTimeoutNumber(readValue(), "--settle-delay-ms", 0);
        break;
      case "--output-dir":
        outputDir = path.resolve(readValue());
        break;
      case "--keep":
        keep = true;
        break;
      case "--allow-non-darwin":
        allowNonDarwin = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (mode !== "fixed" && mode !== "leak" && mode !== "report") {
    throw new Error('--mode must be "fixed", "leak", or "report"');
  }
  fileCount ??= readPositiveNumberEnv("OPENCLAW_MEMORY_FD_REPRO_FILES", DEFAULT_FILE_COUNT);
  maxWorkspaceRegFds ??= readNumberEnv(
    "OPENCLAW_MEMORY_FD_REPRO_MAX_WORKSPACE_REG_FDS",
    DEFAULT_MAX_WORKSPACE_REG_FDS,
  );
  invokeTimeoutMs ??= readTimerTimeoutNumberEnv("OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS", 30_000);
  sampleDelayMs ??= readTimerTimeoutNumberEnv("OPENCLAW_MEMORY_FD_REPRO_SAMPLE_DELAY_MS", 1_000, 0);
  settleDelayMs ??= readTimerTimeoutNumberEnv("OPENCLAW_MEMORY_FD_REPRO_SETTLE_DELAY_MS", 5_000, 0);
  if (!Number.isFinite(fileCount) || fileCount <= 0) {
    throw new Error("file count must be greater than 0");
  }
  if (!Number.isFinite(maxWorkspaceRegFds) || maxWorkspaceRegFds < 0) {
    throw new Error("max workspace REG FD threshold must be non-negative");
  }
  return {
    fileCount,
    mode,
    maxWorkspaceRegFds,
    minLeakedFds: minLeakedFds ?? Math.min(fileCount, 64),
    invokeTimeoutMs,
    sampleDelayMs,
    settleDelayMs,
    outputDir,
    keep,
    allowNonDarwin,
  };
}

function logStep(message: string) {
  console.log(`[memory-fd-repro] ${message}`);
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function distributeFileCounts(total: number) {
  const exact = ISSUE_FILE_COUNTS.map(([dir, count]) => ({
    dir,
    count: Math.floor((count / ISSUE_MEMORY_FILE_COUNT) * total),
    remainder: (count / ISSUE_MEMORY_FILE_COUNT) * total,
  }));
  let assigned = exact.reduce((sum, entry) => sum + entry.count, 0);
  for (const entry of exact.toSorted((a, b) => b.remainder - a.remainder)) {
    if (assigned >= total) {
      break;
    }
    entry.count += 1;
    assigned += 1;
  }
  return exact
    .filter((entry) => entry.count > 0)
    .map(({ dir, count }) => [dir, count] satisfies [string, number]);
}

function writeSyntheticWorkspace(workspaceDir: string, fileCount: number) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "MEMORY.md"),
    "# Memory\n\nTop-level memory file for FD repro.\n",
  );

  for (const [relativeDir, count] of distributeFileCounts(fileCount)) {
    const dir = path.join(workspaceDir, relativeDir);
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 1; index <= count; index += 1) {
      const name = `${String(index).padStart(5, "0")}.md`;
      fs.writeFileSync(
        path.join(dir, name),
        `# ${relativeDir} ${index}\n\nSynthetic memory note ${index}.\n`,
      );
    }
  }
}

/**
 * Writes isolated OpenClaw config for the synthetic memory workspace.
 */
export function writeConfig({ homeDir, workspaceDir, port, token }: ConfigOptions) {
  const configDir = path.join(homeDir, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "openclaw.json");
  const config = {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
      entries: {
        main: {
          default: true,
          tools: { allow: ["memory_search"] },
        },
      },
    },
    memory: {
      search: {
        provider: "none",
        model: "",
        store: {
          vector: { enabled: false },
        },
      },
    },
    plugins: { allow: ["memory-core"] },
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function formatTail(text: string, maxChars = 4096) {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function preindexSyntheticMemory(env: NodeJS.ProcessEnv) {
  logStep("preindex start");
  const result = spawnSync(
    process.execPath,
    ["scripts/run-node.mjs", "memory", "index", "--force", "--agent", "main"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      [
        `memory preindex failed with exit ${result.status ?? result.signal}`,
        formatTail(result.stdout || ""),
        formatTail(result.stderr || ""),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  logStep("preindex complete");
}

/**
 * Updates bounded gateway-ready output state from a stdout/stderr chunk.
 */
export function updateGatewayReadyOutputState(
  state: GatewayReadyOutputState,
  chunk: string,
  maxChars = GATEWAY_READY_OUTPUT_MAX_CHARS,
) {
  const combined = `${state.tail ?? ""}${chunk}`;
  return {
    tail: combined.length > maxChars ? combined.slice(-maxChars) : combined,
    readySeen: state.readySeen || combined.includes("[gateway] ready"),
  };
}

function runLsofForPid(pid: number) {
  const result = spawnSync("lsof", ["-nP", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`lsof failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function findGatewayPid(port: number) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") {
      return null;
    }
    throw new Error(`lsof listener query failed: ${result.stderr || result.stdout}`);
  }
  const pid = Number(result.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function sampleFds({ label, pid, workspaceRealPath }: FdSampleOptions) {
  const output = runLsofForPid(pid);
  const workspacePrefix = `${workspaceRealPath}${path.sep}`;
  const workspaceMarkdownPaths: string[] = [];
  let total = 0;
  let reg = 0;

  for (const line of output.split("\n").slice(1)) {
    if (!line.trim()) {
      continue;
    }
    total += 1;
    const columns = line.trim().split(/\s+/);
    const type = columns[4];
    const filePath = columns[columns.length - 1];
    if (type === "REG") {
      reg += 1;
    }
    if (
      type === "REG" &&
      filePath?.startsWith(workspacePrefix) &&
      (filePath === path.join(workspaceRealPath, "MEMORY.md") ||
        (filePath.startsWith(path.join(workspaceRealPath, "memory") + path.sep) &&
          filePath.endsWith(".md")))
    ) {
      workspaceMarkdownPaths.push(filePath);
    }
  }

  const sample = {
    label,
    totalFds: total,
    regFds: reg,
    workspaceMarkdownRegFds: workspaceMarkdownPaths.length,
    uniqueWorkspaceMarkdownRegFds: new Set(workspaceMarkdownPaths).size,
    sampledAt: new Date().toISOString(),
  };
  logStep(
    `${label}: total=${sample.totalFds} reg=${sample.regFds} workspace_md_reg=${sample.workspaceMarkdownRegFds} unique_workspace_md_reg=${sample.uniqueWorkspaceMarkdownRegFds}`,
  );
  return sample;
}

/**
 * Reports whether a spawned child has already exited.
 */
function hasChildExited(child: ChildExitState) {
  return child.exitCode !== null || child.signalCode !== null;
}

function assertGatewayRunning(child: GatewayReadyChild, tail = "") {
  if (hasChildExited(child)) {
    throw new Error(
      `gateway exited before ready or measurement completed (${child.signalCode ?? child.exitCode})\n${formatTail(tail)}`,
    );
  }
  if (!child.pid) {
    throw new Error("gateway did not acquire a process ID");
  }
  return child.pid;
}

/**
 * Readiness corroborates the launched PID; a port never selects a process owner.
 */
export async function waitForGatewayReady({
  child,
  port,
  logPath,
  timeoutMs,
  outputState = {},
}: GatewayReadyOptions) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pid = assertGatewayRunning(child, outputState.tail);
    if (outputState.readySeen) {
      const listener = findGatewayPid(port);
      if (listener === pid) {
        return pid;
      }
      if (listener !== null) {
        throw new Error("gateway listener does not belong to the launched process");
      }
    }
    await sleep(100);
  }
  throw new Error(`gateway did not become ready within ${timeoutMs}ms; see ${logPath}`);
}

function parseToolTextContent(result: Record<string, unknown> | null) {
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const entry of content) {
    const record = asRecord(entry);
    const text = record?.type === "text" && typeof record.text === "string" ? record.text : null;
    if (!text) {
      continue;
    }
    const parsed = asRecord(safeParseJson(text));
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

/**
 * Classifies the memory_search HTTP response into success/error details.
 */
export function classifyMemorySearchInvokeResponse({
  httpOk,
  status,
  bodyText,
}: InvokeResponseOptions) {
  const parsedBody = safeParseJson(bodyText);
  const body = asRecord(parsedBody);
  if (!httpOk) {
    const errorRecord = asRecord(body?.error);
    return {
      ok: false,
      httpOk,
      status,
      gatewayOk: body?.ok === true ? true : body?.ok === false ? false : undefined,
      error:
        readNonBlankString(errorRecord?.message) ??
        readNonBlankString(body?.error) ??
        `memory_search HTTP request failed with status ${status}`,
    };
  }
  if (!body) {
    return {
      ok: false,
      httpOk,
      status,
      error: "memory_search response was not JSON",
    };
  }

  const gatewayOk = body.ok === true ? true : body.ok === false ? false : undefined;
  if (gatewayOk === false) {
    const errorRecord = asRecord(body.error);
    return {
      ok: false,
      httpOk,
      status,
      gatewayOk,
      error:
        readNonBlankString(errorRecord?.message) ??
        readNonBlankString(body.error) ??
        "memory_search gateway invocation failed",
    };
  }

  const result = asRecord(body.result);
  const details = asRecord(result?.details);
  const directResult = Array.isArray(result?.results) ? result : null;
  const directBody =
    Array.isArray(body.results) || body.disabled === true || body.unavailable === true
      ? body
      : null;
  const payload = details ?? parseToolTextContent(result) ?? directResult ?? directBody;
  if (!payload) {
    return {
      ok: false,
      httpOk,
      status,
      gatewayOk,
      error: "memory_search result payload missing or invalid",
    };
  }
  const resultCount = Array.isArray(payload.results) ? payload.results.length : undefined;
  const toolDisabled = payload.disabled === true;
  const toolUnavailable = payload.unavailable === true;
  const toolError = readNonBlankString(payload.error);
  const ok = gatewayOk === true && !toolDisabled && !toolUnavailable && !toolError;

  return {
    ok,
    httpOk,
    status,
    gatewayOk,
    resultCount,
    toolDisabled,
    toolUnavailable,
    ...(toolError ? { toolError } : {}),
    ...(ok
      ? {}
      : {
          error:
            toolError ??
            (toolDisabled || toolUnavailable
              ? "memory_search returned disabled/unavailable"
              : "memory_search result payload missing or invalid"),
        }),
  };
}

export async function invokeMemorySearch({ port, token, timeoutMs, signal }: InvokeOptions) {
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tool: "memory_search",
        args: {
          query: MEMORY_SEARCH_PROBE_QUERY,
          maxResults: 1,
          corpus: "memory",
        },
        sessionKey: "main",
      }),
      signal: controller.signal,
    });
    const text = await readBoundedResponseText(
      res,
      "memory_search",
      MEMORY_SEARCH_RESPONSE_MAX_BYTES,
      { signal: controller.signal },
    );
    const result = classifyMemorySearchInvokeResponse({
      httpOk: res.ok,
      status: res.status,
      bodyText: text,
    });
    return {
      ...result,
      durationMs: Date.now() - startedAt,
      bodyPreview: text.slice(0, 500),
    };
  } catch (error) {
    return {
      ok: false,
      aborted: error instanceof Error && error.name === "AbortError",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

type FailureOptions = {
  invokePassed: boolean;
  options: ReturnType<typeof parseArgs>;
  peak: number;
};

function formatFailure({ invokePassed, options, peak }: FailureOptions) {
  if (options.mode === "fixed" && !invokePassed) {
    return `memory_search did not complete successfully; see summary invoke details`;
  }
  if (options.mode === "fixed") {
    return `workspace Markdown REG FDs peaked at ${peak}, above max ${options.maxWorkspaceRegFds}`;
  }
  if (options.mode === "leak") {
    return `workspace Markdown REG FDs peaked at ${peak}, below leak threshold ${options.minLeakedFds}`;
  }
  return "";
}

function formatErrors(errors: unknown[]) {
  return [
    ...new Set(
      errors
        .flatMap((error) =>
          error instanceof AggregateError ? [error].concat(error.errors) : [error],
        )
        .map((error) => formatErrorMessage(error).slice(0, 8192)),
    ),
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin" && !options.allowNonDarwin) {
    console.log(
      `[memory-fd-repro] skipped: lsof REG watcher counts are macOS-focused; pass --allow-non-darwin to run on ${process.platform}`,
    );
    return;
  }

  const lsofAvailable = spawnSync("lsof", ["-v"], { stdio: "ignore" }).status === 0;
  if (!lsofAvailable) {
    throw new Error("lsof is required for memory FD repro instrumentation");
  }

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-fd-repro-"));
  const homeDir = path.join(rootDir, "home");
  const workspaceDir = path.join(rootDir, "workspace");
  const logPath = path.join(options.outputDir, "gateway.log");
  const generatedAt = new Date().toISOString();
  const stop = new AbortController();
  const invokeStop = new AbortController();
  const measurementSignal = AbortSignal.any([stop.signal, invokeStop.signal]);
  const outputState: GatewayReadyOutputState = {};
  const errors: unknown[] = [];
  const outputErrors: unknown[] = [];
  let child: ChildProcess | undefined;
  let completion: Promise<{ code: number } | { error: unknown }> | undefined;
  let pendingInvoke: ReturnType<typeof invokeMemorySearch> | undefined;
  let measurement:
    | {
        pid: number;
        samples: ReturnType<typeof sampleFds>[];
        invoke: Awaited<ReturnType<typeof invokeMemorySearch>>;
      }
    | undefined;
  try {
    fs.mkdirSync(options.outputDir, { recursive: true });
    const port = await getFreePort();
    const token = `memory-fd-repro-${process.pid}`;
    writeSyntheticWorkspace(workspaceDir, options.fileCount);
    const configPath = writeConfig({ homeDir, workspaceDir, port, token });
    const workspaceRealPath = fs.realpathSync.native(workspaceDir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...SKIP_GATEWAY_ENV,
      HOME: homeDir,
      OPENCLAW_STATE_DIR: path.join(homeDir, ".openclaw"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      // The measured PID must not respawn for compile-cache activation.
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
    env.OPENCLAW_DEV_SOURCE_ROOT ??= process.cwd();
    preindexSyntheticMemory(env);
    completion = runManagedCommand({
      bin: process.execPath,
      args: [
        path.resolve("openclaw.mjs"),
        "gateway",
        "run",
        "--port",
        String(port),
        "--auth",
        "token",
        "--token",
        token,
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      cwd: process.cwd(),
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal: stop.signal,
      // Cancel measurement without replacing the managed owner's signal outcome.
      onSignal: () => invokeStop.abort(),
      // The shared owner adds its separate 5s output/group drainage allowance.
      abortKillGraceMs: 5_000,
      requireProcessTreeExit: process.platform !== "win32",
      onReady(launched) {
        child = launched;
        launched.once("exit", () => invokeStop.abort());
        const captureOutputError = (error: unknown) => {
          if (outputErrors.length === 0) {
            outputErrors.push(error);
          }
          stop.abort();
        };
        const append = (chunk: Uint8Array | string) => {
          const text = chunk.toString();
          Object.assign(outputState, updateGatewayReadyOutputState(outputState, text));
          try {
            fs.appendFileSync(logPath, text);
          } catch (error) {
            captureOutputError(error);
          }
        };
        // Observe both error channels before data listeners start flowing;
        // read failures must retire the owner through the same cleanup path.
        launched.stdout!.on("error", captureOutputError);
        launched.stderr!.on("error", captureOutputError);
        launched.stdout!.on("data", append);
        launched.stderr!.on("data", append);
      },
    }).then(
      (code) => ({ code }),
      (error: unknown) => ({ error }),
    );
    // onReady is synchronous. Observe completion immediately, then measure
    // outside that callback so setup, measurement and teardown share one owner.
    if (!child) {
      const result = await completion;
      throw "error" in result ? result.error : new Error("gateway failed to launch");
    }
    const ownedChild = child;
    logStep(`workspace=${workspaceDir}`);
    logStep(`files=${options.fileCount} mode=${options.mode} port=${port}`);
    const pid = await waitForGatewayReady({
      child: ownedChild,
      port,
      logPath,
      timeoutMs: 60_000,
      outputState,
    });
    const sample = (label: string) => {
      assertGatewayRunning(ownedChild, outputState.tail);
      if (findGatewayPid(port) !== pid) {
        throw new Error("gateway listener no longer belongs to the launched process");
      }
      return sampleFds({ label, pid, workspaceRealPath });
    };
    const samples = [sample("baseline")];
    pendingInvoke = invokeMemorySearch({
      port,
      token,
      timeoutMs: options.invokeTimeoutMs,
      signal: measurementSignal,
    });
    await sleep(options.sampleDelayMs, undefined, { signal: measurementSignal });
    samples.push(sample("during"));
    const invoke = await pendingInvoke;
    logStep(`invoke=${JSON.stringify(invoke)}`);
    await sleep(options.settleDelayMs, undefined, { signal: measurementSignal });
    samples.push(sample("settled"));
    measurement = { pid, samples, invoke };
  } catch (error) {
    errors.push(error);
  } finally {
    // A sampling failure must also retire the request it started, before
    // releasing either the Gateway's inputs or the measurement owner.
    invokeStop.abort();
    await pendingInvoke;
    if (completion) {
      if (child && !hasChildExited(child)) {
        stop.abort();
      }
      const result = await completion;
      if ("error" in result) {
        // Only this owner's abort, after the helper verified cleanup, is expected.
        if (
          !stop.signal.aborted ||
          !(result.error instanceof Error) ||
          !("code" in result.error) ||
          result.error.code !== "ABORT_ERR"
        ) {
          errors.push(result.error);
        }
      } else if (result.code !== 0) {
        errors.push(
          new Error(
            `gateway exited with code ${result.code}\n${formatTail(outputState.tail ?? "")}`,
          ),
        );
      }
    }
    errors.push(...outputErrors);
    if (!options.keep && !errors.some(hasUnjoinedWork)) {
      try {
        fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch (error) {
        errors.push(error);
      }
    } else {
      logStep(`kept synthetic root=${rootDir}`);
    }
  }
  if (measurement) {
    const { pid, samples, invoke } = measurement;
    const peak = Math.max(...samples.map((sample) => sample.uniqueWorkspaceMarkdownRegFds));
    const invokePassed = invoke.ok;
    const measurementPassed =
      options.mode === "report" ||
      (options.mode === "fixed" && invokePassed && peak <= options.maxWorkspaceRegFds) ||
      (options.mode === "leak" && peak >= options.minLeakedFds);
    if (!measurementPassed) {
      errors.unshift(new Error(formatFailure({ invokePassed, options, peak })));
    }
    // Retain completed measurements after settlement, even when cleanup failed.
    // Report-only exempts thresholds, never ownership or cleanup.
    const summary = {
      generatedAt,
      platform: process.platform,
      mode: options.mode,
      fileCount: options.fileCount,
      expectedMarkdownFiles: options.fileCount + 1,
      thresholds: {
        maxWorkspaceRegFds: options.maxWorkspaceRegFds,
        minLeakedFds: options.minLeakedFds,
      },
      rootDir,
      outputDir: options.outputDir,
      samples,
      invoke,
      gatewayPid: pid,
      peakUniqueWorkspaceMarkdownRegFds: peak,
      passed: errors.length === 0,
      failure: errors.length > 0 ? formatErrors(errors) : undefined,
    };
    try {
      fs.writeFileSync(
        path.join(options.outputDir, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      logStep(`summary=${path.join(options.outputDir, "summary.json")}`);
    } catch (error) {
      errors.push(error);
    }
  } else if (errors.length === 0) {
    errors.push(new Error("gateway measurement did not complete"));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, formatErrors(errors));
  }
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(
      `[memory-fd-repro] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
