import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
// Bench Gateway Concurrency script measures gateway probes during synthetic streaming turns.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { ModelsListResult } from "../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { asFiniteNumber } from "../packages/normalization-core/src/number-coercion.ts";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";
import { sliceUtf16Safe } from "../packages/normalization-core/src/utf16-slice.ts";
import type { createAgentTurnService } from "../src/gateway/agent-turn/agent-turn-service.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import {
  summarizeMockInferenceRequest,
  type MockInferenceFacts,
} from "./e2e/lib/mock-inference-facts.ts";
import {
  startGatewayBrowserProbe,
  type BrowserSessionClick,
  type BrowserSessionTarget,
} from "./lib/gateway-bench-browser.ts";
import { delay, stopChild } from "./lib/gateway-bench-child.ts";
import {
  type GatewayMemorySample,
  type GatewayRpc,
  getFreePort,
  readGatewayMemory,
  readProcessRssMb,
} from "./lib/gateway-bench-probes.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayCpuProfile,
  readGatewayCpuUsage,
  readGatewayHeapProfile,
  type GatewayHeapProfile,
  type GatewayCpuProfile,
  type GatewayCpuUsage,
} from "./lib/gateway-bench-profile.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  CliArgumentError,
  createGatewayBenchEnv,
  hasFlag,
  hasHelpFlag,
  parseFlagValue,
  parseNonNegativeInt,
  parsePositiveInt,
  resolveEntry,
  resolveOutputPath,
  validateCliArgs,
  waitForInitialProbe,
  writeGatewayBenchConfig,
  writePluginFixtures,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

type MetricSummary = {
  count: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
};

type TimedProbe = {
  atMs: number;
  error: string | null;
  latencyMs: number;
  ok: boolean;
};

type DiagnosticsTimelineSpan = {
  durationMs?: number;
  name?: string;
};

type ReadyProbe = TimedProbe & {
  cpuCoreRatio: number | null;
  degraded: boolean | null;
  degradedSinceMs: number | null;
  delayP99Ms: number | null;
  delayMaxMs: number | null;
  status: number;
  utilization: number | null;
};

type ControlUiProbe = TimedProbe & {
  status: number;
};

type GatewaySample = {
  controlUi: ControlUiProbe;
  readyz: ReadyProbe;
  sessionsList: TimedProbe;
};

type FreshConnectionProbe = {
  error: string | null;
  latencyMs: number;
  ok: boolean;
};

type GatewayChildExit = {
  atMonotonicMicros: number;
  exitCode: number | null;
  signal: string | null;
};

type MainProfileArtifacts = {
  scope: "main-isolate";
  workersManifestPath: string;
};

type BenchmarkRun = {
  agentCoverage?: {
    configuredAgentIds: string[];
    activeTurnAgentIds: string[];
    beforeLoad: Array<{
      agentId: string;
      models: ModelsListResult;
      sessions: SessionsListResult[];
    }>;
    completedTurns: Array<{ agentId: string; count: number }>;
  };
  browser?: {
    newPageReadyMs: number;
    initialSessionReadyMs: number | null;
    historyMessagesPerTarget: number;
    inventory: {
      seededLoadSessions: number;
      seededClickSessions: number;
      unarchivedSessions: number;
      retainedSessions: number;
    };
    clicks: BrowserSessionClick[];
  };
  heapProfile?: GatewayHeapProfile & MainProfileArtifacts;
  loadCpuProfile?: GatewayCpuProfile & MainProfileArtifacts;
  controlPlane: Array<TimedProbe & { method: string }>;
  controlUi: ControlUiProbe[];
  cpuUsage: GatewayCpuUsage;
  durationMs: number;
  freshConnection: FreshConnectionProbe;
  gatewayExit?: Awaited<ReturnType<typeof stopChild>>;
  gatewayProcess?: {
    pid: number | undefined;
    exitCode: number | null | undefined;
    signalCode: string | null | undefined;
    exitEvent: GatewayChildExit | undefined;
    closeEvent: GatewayChildExit | undefined;
  };
  processPlacement?: {
    driver: { pid: number; affinity?: string };
    mockProvider: { pid: number; affinity?: string };
  };
  loadWindow?: { startMonotonicMicros: number; endMonotonicMicros: number };
  history: Array<TimedProbe & { sessionKey?: string }>;
  memory: { after: GatewayMemorySample; before: GatewayMemorySample; peakRssMb: number };
  messageSubscriptions: TimedProbe[];
  messageSubscriptionsDuringLoad: TimedProbe[];
  mockRequests: ReturnType<typeof summarizeMockRequests>;
  turnEvidence: ReturnType<ReturnType<typeof createTurnEvidence>["finish"]>;
  providerRequests: ReturnType<typeof summarizeProviderRequests>;
  turnAccounting: { launched: number; terminalOk: number; verified: number };
  agentWarmup: {
    durationMs: number;
    launched: number;
    terminalOk: number;
    verified: number;
    beforeOrdinal: number;
    afterOrdinal: number;
    turnEvidence: ReturnType<ReturnType<typeof createTurnEvidence>["finish"]>;
  };
  probeWarmup: {
    durationMs: number;
    samples: GatewaySample[];
  };
  pluginMetadataScans: ReturnType<typeof summarizePluginMetadataScans>;
  readyz: ReadyProbe[];
  sessionSeedDurationMs: number;
  sessionsList: TimedProbe[];
  sessionUpdates: TimedProbe[];
  setupDurationMs: number;
  turnCount: number;
  turnsDurationMs: number;
};

type CliOptions = {
  agentCount: number;
  agentWarmupTurns: number;
  gatewayCpus?: string;
  browserHistoryMessages: number;
  browserSessionClicks: number;
  cadenceMs: number;
  concurrency: number;
  controlPlane: boolean;
  cpuProfDir?: string;
  loadCpuProfDir?: string;
  heapProfDir?: string;
  diagnosticsTimeline: boolean;
  entry: string;
  historyBurst: number;
  historyClients: number;
  historyMessages: number;
  historyMessageChars: number;
  json: boolean;
  maxControlMs?: number;
  maxHandshakeMs?: number;
  output?: string;
  pluginCount: number;
  probeRounds?: number;
  runs: number;
  sessionCount: number;
  sessionUpdateClients: number;
  sessionUpdates: number;
  streamChunkDelayMs: number;
  subscribers: number;
  timeoutMs: number;
  toolEvents: boolean;
  turnsPerSession: number;
  visibleObserver: boolean;
  warmup: number;
  workspaceFanout: boolean;
};

const DEFAULT_CADENCE_MS = 100;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_ENTRY = "dist/entry.js";
const DEFAULT_RUNS = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WARMUP = 0;
const MOCK_RESPONSE_CHUNK_DELAY_MS = 1_000;
const STREAM_SUCCESS_MARKER = "OpenClaw gateway concurrency benchmark streaming response.";
const TOOL_SUCCESS_MARKER = "OPENCLAW_E2E_DRAFTPROOF";
const MAX_AGENT_COUNT = 128;
const MAX_CONCURRENCY = 64;
const MAX_TURNS_PER_SESSION = 100;
const MAX_PLUGIN_COUNT = 100;
const MAX_SESSION_COUNT = 10_000;
const MAX_SESSION_UPDATES = 100_000;
const MAX_SESSION_SEED_CONCURRENCY = 16;
const MAX_RUNS = 20;
const MAX_WARMUP = 10;
const MAX_SAMPLES_PER_RUN = 2_048;
const MAX_HTTP_BODY_BYTES = 1_048_576;
const HTTP_TIMEOUT_MS = 20_000;
const PROBE_WARMUP_TIMEOUT_MS = 60_000;
const PROBE_WARMUP_TARGET_MS = 1_000;
const PROBE_WARMUP_RETRY_DELAY_MS = 100;
const GATEWAY_STDERR_TAIL_LINES = 20;
const AGENT_WAIT_RPC_GRACE_MS = 5_000;
const UTILITY_MODEL_ID = "gateway-bench-utility";
const OBSERVER_ASSESSMENT = "Synthetic benchmark observation is valid.";
const MOCK_INGRESS_KEYS = ["responses", "chatCompletions", "embeddings", "other"] as const;
const MOCK_SELECTION_KEYS = ["model", "global", "automaticTool", "automaticText"] as const;
type MockRequestSnapshot = {
  id: string;
  ingress: Record<(typeof MOCK_INGRESS_KEYS)[number], number>;
  selections: Record<(typeof MOCK_SELECTION_KEYS)[number], number>;
  beforeMs: number;
  afterMs: number;
};
const BOOLEAN_FLAGS = new Set([
  "--help",
  "-h",
  "--json",
  "--control-plane",
  "--no-diagnostics-timeline",
  "--tool-events",
  "--visible-observer",
  "--workspace-fanout",
]);
const VALUE_FLAGS = new Set([
  "--agent-count",
  "--agent-warmup-turns",
  "--gateway-cpus",
  "--browser-history-messages",
  "--browser-session-clicks",
  "--cadence-ms",
  "--concurrency",
  "--cpu-prof-dir",
  "--load-cpu-prof-dir",
  "--heap-prof-dir",
  "--entry",
  "--history-burst",
  "--history-clients",
  "--history-messages",
  "--history-message-chars",
  "--max-control-ms",
  "--max-handshake-ms",
  "--output",
  "--plugin-count",
  "--probe-rounds",
  "--runs",
  "--session-count",
  "--session-update-clients",
  "--session-updates",
  "--stream-chunk-delay-ms",
  "--subscribers",
  "--timeout-ms",
  "--turns-per-session",
  "--warmup",
]);

function parseBoundedPositiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  max: number,
): number {
  const value = parsePositiveInt(raw, fallback, label);
  if (value > max) {
    throw new CliArgumentError(`${label} must be at most ${max}`);
  }
  return value;
}

function parseBoundedNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  max: number,
): number {
  const value = parseNonNegativeInt(raw, fallback, label);
  if (value > max) {
    throw new CliArgumentError(`${label} must be at most ${max}`);
  }
  return value;
}

function parseOptions(argv: string[] = process.argv.slice(2)): CliOptions {
  validateCliArgs(argv, { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  const options = {
    agentCount: parseBoundedPositiveInt(
      parseFlagValue(argv, "--agent-count"),
      1,
      "--agent-count",
      MAX_AGENT_COUNT,
    ),
    browserHistoryMessages: parseBoundedPositiveInt(
      parseFlagValue(argv, "--browser-history-messages"),
      80,
      "--browser-history-messages",
      500,
    ),
    browserSessionClicks: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--browser-session-clicks"),
      0,
      "--browser-session-clicks",
      20,
    ),
    cadenceMs: parseBoundedPositiveInt(
      parseFlagValue(argv, "--cadence-ms"),
      DEFAULT_CADENCE_MS,
      "--cadence-ms",
      5_000,
    ),
    concurrency: parseBoundedPositiveInt(
      parseFlagValue(argv, "--concurrency"),
      DEFAULT_CONCURRENCY,
      "--concurrency",
      MAX_CONCURRENCY,
    ),
    controlPlane: hasFlag(argv, "--control-plane"),
    cpuProfDir: resolveOutputPath(parseFlagValue(argv, "--cpu-prof-dir")),
    loadCpuProfDir: resolveOutputPath(parseFlagValue(argv, "--load-cpu-prof-dir")),
    heapProfDir: resolveOutputPath(parseFlagValue(argv, "--heap-prof-dir")),
    diagnosticsTimeline: !hasFlag(argv, "--no-diagnostics-timeline"),
    entry: resolveEntry(parseFlagValue(argv, "--entry"), DEFAULT_ENTRY),
    historyBurst: parseBoundedPositiveInt(
      parseFlagValue(argv, "--history-burst"),
      5,
      "--history-burst",
      32,
    ),
    historyClients: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--history-clients"),
      0,
      "--history-clients",
      MAX_CONCURRENCY,
    ),
    historyMessages: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--history-messages"),
      0,
      "--history-messages",
      500,
    ),
    historyMessageChars: parseBoundedPositiveInt(
      parseFlagValue(argv, "--history-message-chars"),
      1_024,
      "--history-message-chars",
      65_536,
    ),
    json: hasFlag(argv, "--json"),
    maxControlMs: parseFlagValue(argv, "--max-control-ms")
      ? parseBoundedPositiveInt(
          parseFlagValue(argv, "--max-control-ms"),
          2_000,
          "--max-control-ms",
          30_000,
        )
      : undefined,
    maxHandshakeMs: parseFlagValue(argv, "--max-handshake-ms")
      ? parseBoundedPositiveInt(
          parseFlagValue(argv, "--max-handshake-ms"),
          2_000,
          "--max-handshake-ms",
          30_000,
        )
      : undefined,
    output: resolveOutputPath(parseFlagValue(argv, "--output")),
    pluginCount: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--plugin-count"),
      0,
      "--plugin-count",
      MAX_PLUGIN_COUNT,
    ),
    probeRounds:
      parseFlagValue(argv, "--probe-rounds") === undefined
        ? undefined
        : parseBoundedPositiveInt(
            parseFlagValue(argv, "--probe-rounds"),
            1,
            "--probe-rounds",
            MAX_SAMPLES_PER_RUN,
          ),
    runs: parseBoundedPositiveInt(parseFlagValue(argv, "--runs"), DEFAULT_RUNS, "--runs", MAX_RUNS),
    sessionCount: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--session-count"),
      0,
      "--session-count",
      MAX_SESSION_COUNT,
    ),
    sessionUpdateClients: parseBoundedPositiveInt(
      parseFlagValue(argv, "--session-update-clients"),
      4,
      "--session-update-clients",
      MAX_CONCURRENCY,
    ),
    sessionUpdates: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--session-updates"),
      0,
      "--session-updates",
      MAX_SESSION_UPDATES,
    ),
    streamChunkDelayMs: parseBoundedPositiveInt(
      parseFlagValue(argv, "--stream-chunk-delay-ms"),
      MOCK_RESPONSE_CHUNK_DELAY_MS,
      "--stream-chunk-delay-ms",
      30_000,
    ),
    subscribers: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--subscribers"),
      0,
      "--subscribers",
      MAX_CONCURRENCY,
    ),
    timeoutMs: parseBoundedPositiveInt(
      parseFlagValue(argv, "--timeout-ms"),
      DEFAULT_TIMEOUT_MS,
      "--timeout-ms",
      10 * 60_000,
    ),
    gatewayCpus: parseFlagValue(argv, "--gateway-cpus"),
    agentWarmupTurns: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--agent-warmup-turns"),
      0,
      "--agent-warmup-turns",
      MAX_WARMUP,
    ),
    toolEvents: hasFlag(argv, "--tool-events"),
    turnsPerSession: parseBoundedPositiveInt(
      parseFlagValue(argv, "--turns-per-session"),
      1,
      "--turns-per-session",
      MAX_TURNS_PER_SESSION,
    ),
    visibleObserver: hasFlag(argv, "--visible-observer"),
    warmup: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--warmup"),
      DEFAULT_WARMUP,
      "--warmup",
      MAX_WARMUP,
    ),
    workspaceFanout: hasFlag(argv, "--workspace-fanout"),
  };
  if (options.gatewayCpus !== undefined && !/^\d+(?:,\d+)*$/u.test(options.gatewayCpus)) {
    throw new CliArgumentError("--gateway-cpus requires comma-separated CPU numbers");
  }
  if (options.loadCpuProfDir && options.heapProfDir) {
    throw new CliArgumentError(
      "--load-cpu-prof-dir and --heap-prof-dir require separate benchmark runs",
    );
  }
  if (options.agentCount > Math.max(options.sessionCount, options.concurrency)) {
    throw new CliArgumentError("--agent-count must not exceed the total session count");
  }
  const historyMessageCount =
    Math.max(options.sessionCount, options.concurrency) * options.historyMessages +
    (options.browserSessionClicks > 0
      ? (options.browserSessionClicks + 1) * options.browserHistoryMessages
      : 0);
  if (
    options.probeRounds !== undefined &&
    options.probeRounds * options.historyClients * options.historyBurst > MAX_SAMPLES_PER_RUN
  ) {
    throw new CliArgumentError("fixed history workload must not exceed 2048 requests per run");
  }
  if (
    historyMessageCount > 100_000 ||
    historyMessageCount * options.historyMessageChars > 256 * 1024 * 1024
  ) {
    throw new CliArgumentError("synthetic history must not exceed 100000 messages or 256 MiB");
  }
  return options;
}

function printUsage(): void {
  console.log(`OpenClaw Gateway concurrency benchmark

Usage:
  pnpm test:gateway:concurrency -- [options]
  node scripts/bench-gateway-concurrency.ts [options]

Options:
  --agent-count <n> Configured agents sharing the fixed session inventory (default: 1, max: ${MAX_AGENT_COUNT})
  --browser-history-messages <n> Messages per browser click target, independent of inventory history (default: 80, max: 500)
  --browser-session-clicks <n> Click n existing sessions and revisit one during load (default: 0, max: 20; requires built UI and Chromium)
  --concurrency <n>  Concurrent synthetic sessions (default: ${DEFAULT_CONCURRENCY})
  --gateway-cpus <list> Linux Gateway-only CPU affinity (comma-separated CPU numbers)
  --agent-warmup-turns <n> Verified turns per active session in the same Gateway before load (default: 0, max: ${MAX_WARMUP})
  --turns-per-session <n> Serial turns per session (default: 1, max: ${MAX_TURNS_PER_SESSION})
  --control-plane   Also probe tasks.list, cron.list, and cron.status during load
  --history-messages <n> Inject up to 500 synthetic messages per seeded session
  --history-message-chars <n> Synthetic message size (default: 1024, max: 65536)
  --cpu-prof-dir <p> Write Gateway V8 CPU profiles to this directory
  --load-cpu-prof-dir <p> Capture load-phase main/Worker CPU over private IPC, including on Windows
  --heap-prof-dir <p> Sample load-phase main/Worker allocations, including GC-collected objects
  --runs <n>         Measured gateway runs (default: ${DEFAULT_RUNS})
  --warmup <n>       Warmup gateway runs (default: ${DEFAULT_WARMUP})
  --cadence-ms <ms>  Probe cadence (default: ${DEFAULT_CADENCE_MS})
  --probe-rounds <n> Run exactly n sampler rounds and n bursts per history client
  --timeout-ms <ms>  Per-run cap, excluding probe warmup (default: ${DEFAULT_TIMEOUT_MS})
  --entry <path>     Gateway CLI entry file (default: ${DEFAULT_ENTRY})
  --session-count <n> Seed up to ${MAX_SESSION_COUNT} distinct sessions before load
  --session-updates <n> Bounded public sessions.patch mutations during load
  --session-update-clients <n> Concurrent session mutation clients (default: 4)
  --history-clients <n> Concurrent dedicated history-prefetch WebSocket clients
  --history-burst <n> Parallel history requests per prefetch client (default: 5)
  --subscribers <n> Dedicated session-message subscription clients
  --stream-chunk-delay-ms <n> Mock-provider delay between stream chunks (default: ${MOCK_RESPONSE_CHUNK_DELAY_MS})
  --visible-observer Mark subscribed clients visible to exercise session observation
  --no-diagnostics-timeline Disable diagnostics timeline file writes
  --plugin-count <n> Configure synthetic plugins through plugins.load.paths (default: 0)
  --tool-events      Make every synthetic turn execute a tool before replying
  --workspace-fanout Bind each session to a distinct workspace
  --max-control-ms   Fail when any load-phase health/control probe exceeds this bound
  --max-handshake-ms Fail when a fresh authenticated connection exceeds this bound
  --output <path>    Write machine-readable JSON to a file
  --json             Emit machine-readable JSON
  --help, -h         Show this text
`);
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function summarizeNumbers(values: readonly number[]): MetricSummary | null {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  return {
    count: sorted.length,
    max: sorted.at(-1) ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function summarizePluginMetadataScans(events: readonly DiagnosticsTimelineSpan[]) {
  const durations = events.flatMap((event) =>
    event.name === "plugins.metadata.scan" &&
    typeof event.durationMs === "number" &&
    Number.isFinite(event.durationMs)
      ? [event.durationMs]
      : [],
  );
  return {
    count: durations.length,
    durationMs: summarizeNumbers(durations),
    totalDurationMs: durations.reduce((sum, durationMs) => sum + durationMs, 0),
  };
}

function readDiagnosticsTimelineSpans(
  timelinePath: string,
  window?: { from: number; through: number },
): DiagnosticsTimelineSpan[] {
  const contents = readFileSync(timelinePath, "utf8");
  if (!contents.trim() || !contents.endsWith("\n")) {
    throw new Error("diagnostics timeline is empty or incomplete");
  }
  return contents
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const event: unknown = JSON.parse(line);
      if (
        !isRecord(event) ||
        event.schemaVersion !== "openclaw.diagnostics.v1" ||
        typeof event.timestamp !== "string" ||
        !Number.isFinite(Date.parse(event.timestamp))
      ) {
        throw new Error("invalid diagnostics timeline record");
      }
      const timestamp = Date.parse(event.timestamp);
      if (window && (timestamp < window.from || timestamp > window.through)) {
        return [];
      }
      if (event.type !== "span.end") {
        return [];
      }
      if (
        typeof event.name !== "string" ||
        typeof event.durationMs !== "number" ||
        !Number.isFinite(event.durationMs)
      ) {
        throw new Error("invalid diagnostics timeline span");
      }
      return [{ name: event.name, durationMs: event.durationMs }];
    });
}

function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - performance.now());
}

function requireRemainingMs(deadlineAt: number, label: string): number {
  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) {
    throw new Error(`benchmark timed out while ${label}`);
  }
  return remaining;
}

async function requestHttp(params: {
  accept: string;
  deadlineAt: number;
  path: string;
  port: number;
}): Promise<{ body: string; latencyMs: number; status: number }> {
  const startedAt = performance.now();
  const requestDeadlineAt = Math.min(params.deadlineAt, startedAt + HTTP_TIMEOUT_MS);
  requireRemainingMs(requestDeadlineAt, `requesting ${params.path}`);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      run();
    };
    const fail = (error: Error) =>
      settle(() => {
        req.destroy();
        reject(error);
      });
    const req = request(
      {
        headers: { accept: params.accept },
        host: "127.0.0.1",
        method: "GET",
        path: params.path,
        port: params.port,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_HTTP_BODY_BYTES) {
            fail(new Error(`${params.path} response exceeded ${MAX_HTTP_BODY_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.once("aborted", () => fail(new Error(`${params.path} response aborted`)));
        res.once("error", fail);
        res.once("end", () =>
          settle(() =>
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              latencyMs: performance.now() - startedAt,
              status: res.statusCode ?? 0,
            }),
          ),
        );
      },
    );
    req.once("error", fail);
    // Request/socket timeouts measure inactivity; this timer owns the wall-clock deadline.
    const timer = setTimeout(
      () => fail(new Error(`${params.path} request timed out`)),
      Math.max(1, Math.ceil(remainingMs(requestDeadlineAt))),
    );
    timer.unref?.();
    req.end();
  });
}

function describeProbeError(error: unknown): string {
  return sliceUtf16Safe(error instanceof Error ? error.message : String(error), 0, 500);
}

function formatProbeResult(name: string, probe: TimedProbe & { status?: number }): string {
  const status = probe.status === undefined ? "n/a" : probe.status;
  return `${name}: ok=${probe.ok} status=${status} latencyMs=${probe.latencyMs.toFixed(1)} error=${probe.error ? JSON.stringify(probe.error) : "none"}`;
}

function formatProbeFailure(sample: GatewaySample): string {
  return [
    "gateway probes did not become fast and healthy before concurrent load",
    formatProbeResult("readyz", sample.readyz),
    formatProbeResult("sessionsList", sample.sessionsList),
    formatProbeResult("controlUi", sample.controlUi),
  ].join("\n  ");
}

function tailLines(output: string, lineCount: number): string {
  return output.trimEnd().split(/\r?\n/u).slice(-lineCount).join("\n");
}

function captureChildOutput(child: ChildProcess): {
  readOutput: () => string;
  readStderrTail: () => string;
} {
  if (!child.stdout || !child.stderr) {
    throw new Error("Gateway benchmark children require piped stdout and stderr");
  }
  let output = "";
  let stderr = "";
  const appendOutput = (chunk: Buffer) => {
    output = sliceUtf16Safe(`${output}${chunk.toString("utf8")}`, -64 * 1_024);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", (chunk: Buffer) => {
    appendOutput(chunk);
    stderr = sliceUtf16Safe(`${stderr}${chunk.toString("utf8")}`, -64 * 1_024);
  });
  return {
    readOutput: () => output,
    readStderrTail: () => tailLines(stderr, GATEWAY_STDERR_TAIL_LINES),
  };
}

function formatRunFailure(
  error: unknown,
  gatewayOutput: { readOutput: () => string; readStderrTail: () => string },
  mockOutput: { readOutput: () => string },
): string {
  return [
    error instanceof Error ? error.message : String(error),
    gatewayOutput.readStderrTail()
      ? `gateway stderr tail:\n${gatewayOutput.readStderrTail()}`
      : "gateway stderr tail: (empty)",
    gatewayOutput.readOutput() ? `gateway output tail:\n${gatewayOutput.readOutput()}` : "",
    mockOutput.readOutput() ? `mock provider output tail:\n${mockOutput.readOutput()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function waitForMockServer(port: number, deadlineAt: number): Promise<void> {
  let lastError: unknown;
  while (remainingMs(deadlineAt) > 0) {
    try {
      const result = await requestHttp({
        accept: "application/json",
        deadlineAt,
        path: "/health",
        port,
      });
      if (result.status === 200) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(25, remainingMs(deadlineAt)));
  }
  const detail =
    lastError instanceof Error
      ? lastError.message
      : typeof lastError === "string"
        ? lastError
        : "timeout";
  throw new Error(`mock provider did not become healthy: ${detail}`);
}

async function waitForGatewayDispatchReady(
  readOutput: () => string,
  deadlineAt: number,
): Promise<void> {
  while (remainingMs(deadlineAt) > 0) {
    if (readOutput().includes("startup trace: sidecars.ready ")) {
      return;
    }
    await delay(Math.min(25, remainingMs(deadlineAt)));
  }
  throw new Error("gateway did not finish dispatch-ready sidecars");
}

function parseMockRequests(value: unknown, beforeMs: number, afterMs: number): MockRequestSnapshot {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || value.id.length > 64) {
    throw new Error("mock request counter identity is missing");
  }
  const counts = <K extends string>(record: unknown, keys: readonly K[]): Record<K, number> => {
    if (
      !isRecord(record) ||
      Object.keys(record).length !== keys.length ||
      keys.some((key) => !Number.isSafeInteger(record[key]) || (record[key] as number) < 0)
    ) {
      throw new Error("mock request counters are invalid");
    }
    return Object.fromEntries(keys.map((key) => [key, record[key]])) as Record<K, number>;
  };
  return {
    id: value.id,
    ingress: counts(value.ingress, MOCK_INGRESS_KEYS),
    selections: counts(value.selections, MOCK_SELECTION_KEYS),
    beforeMs,
    afterMs,
  };
}

async function readMockRequests(port: number, deadlineAt: number): Promise<MockRequestSnapshot> {
  const beforeMs = performance.now();
  const response = await requestHttp({
    accept: "application/json",
    port,
    path: "/health",
    deadlineAt,
  });
  const afterMs = performance.now();
  if (response.status !== 200) {
    throw new Error(`mock request checkpoint failed: HTTP ${response.status}`);
  }
  return parseMockRequests(JSON.parse(response.body).requests, beforeMs, afterMs);
}

function summarizeMockRequests(checkpoints: readonly MockRequestSnapshot[]) {
  const phases = ["startupAndWarmup", "setup", "agentWarmup", "loadBracket", "postLoad"] as const;
  if (checkpoints.length !== phases.length + 1) {
    throw new Error("mock request checkpoints are incomplete");
  }
  const first = checkpoints[0]!;
  if (
    [...Object.values(first.ingress), ...Object.values(first.selections)].some(
      (count) => count !== 0,
    )
  ) {
    throw new Error("mock request counters were not zero before Gateway startup");
  }
  for (let index = 0; index < checkpoints.length; index += 1) {
    const current = checkpoints[index]!;
    const previous = checkpoints[Math.max(0, index - 1)]!;
    if (
      current.id !== first.id ||
      !Number.isFinite(current.beforeMs) ||
      !Number.isFinite(current.afterMs) ||
      current.afterMs < current.beforeMs ||
      (index > 0 && current.beforeMs < previous.afterMs) ||
      MOCK_INGRESS_KEYS.some((key) => current.ingress[key] < previous.ingress[key]) ||
      MOCK_SELECTION_KEYS.some((key) => current.selections[key] < previous.selections[key])
    ) {
      throw new Error("mock request checkpoints changed identity or regressed");
    }
  }
  const difference = (after: MockRequestSnapshot, before: MockRequestSnapshot) =>
    Object.fromEntries(
      MOCK_INGRESS_KEYS.map((key) => [key, after.ingress[key] - before.ingress[key]]),
    ) as MockRequestSnapshot["ingress"];
  return {
    // Acknowledged HTTP brackets partition ingress, not causal work or exact CPU windows.
    checkpoints,
    ingress: {
      ...Object.fromEntries(
        phases.map((phase, index) => [
          phase,
          difference(checkpoints[index + 1]!, checkpoints[index]!),
        ]),
      ),
      total: difference(checkpoints.at(-1)!, first),
    },
    selections: { ...checkpoints.at(-1)!.selections },
  };
}

function createTurnEvidence(toolEvents: boolean) {
  const turns = new Map<
    string,
    {
      sessionKey: string;
      phase: "warmup" | "load";
      toolCallId?: string;
      toolCompleted: boolean;
      final: boolean;
      observer: boolean;
    }
  >();
  let invalid = false;
  return {
    register(runId: string, sessionKey: string, phase: "warmup" | "load" = "load") {
      if (turns.has(runId)) {
        throw new Error("duplicate benchmark run identity");
      }
      turns.set(runId, { sessionKey, phase, toolCompleted: false, final: false, observer: false });
    },
    onEvent(this: void, event: { event: string; payload?: unknown }) {
      const payload = event.payload;
      if (!isRecord(payload) || typeof payload.runId !== "string") {
        return;
      }
      const turn = turns.get(payload.runId);
      if (!turn) {
        return;
      }
      if (event.event === "session.observer") {
        if (payload.sessionKey === turn.sessionKey && payload.assessment === OBSERVER_ASSESSMENT) {
          turn.observer = true;
        }
        return;
      }
      if (!toolEvents || event.event !== "session.tool") {
        return;
      }
      // The WebSocket callback cannot throw into runTurn's promise. Retain bounded
      // failure state through client teardown, including late duplicate results.
      const data = payload.data;
      if (
        payload.sessionKey !== turn.sessionKey ||
        !isRecord(data) ||
        data.name !== "exec" ||
        typeof data.toolCallId !== "string"
      ) {
        invalid = true;
        return;
      }
      if (data.phase === "start") {
        invalid ||= turn.toolCallId !== undefined;
        turn.toolCallId = data.toolCallId;
      } else if (data.phase === "result") {
        const result = isRecord(data.result) ? data.result : {};
        const details = isRecord(result.details) ? result.details : {};
        invalid ||=
          turn.toolCompleted ||
          turn.toolCallId !== data.toolCallId ||
          data.isError !== false ||
          details.status !== "completed" ||
          details.exitCode !== 0 ||
          typeof details.aggregated !== "string" ||
          !details.aggregated.includes("openclaw-draft-proof");
        turn.toolCompleted = true;
      }
    },
    complete(runId: string, terminalReply: unknown) {
      const turn = turns.get(runId);
      if (
        !turn ||
        turn.final ||
        !isRecord(terminalReply) ||
        terminalReply.disposition !== "visible" ||
        terminalReply.text !== "OPENCLAW_E2E_DRAFTPROOF"
      ) {
        throw new Error("benchmark tool turn did not produce its expected visible final reply");
      }
      turn.final = true;
    },
    finish(phase: "warmup" | "load" = "load") {
      const allTurns = [...turns.values()];
      if (
        invalid ||
        (toolEvents &&
          allTurns.some((turn) => !turn.toolCallId || !turn.toolCompleted || !turn.final))
      ) {
        throw new Error(
          "benchmark tool lifecycle evidence is missing, duplicated, or unsuccessful",
        );
      }
      // Validate late events from both phases, but keep warmup out of measured totals.
      const phaseTurns = allTurns.filter((turn) => turn.phase === phase);
      return {
        toolTurns: toolEvents ? phaseTurns.length : 0,
        observerModelDigestTurns: phaseTurns.filter((turn) => turn.observer).length,
      };
    },
  };
}

function buildConfig(
  root: string,
  mockPort: number,
  concurrency: number,
  pluginCount: number,
  browserSessionClicks: number,
  agentIds: string[],
): string {
  const controlUiRoot = path.join(root, "control-ui");
  mkdirSync(controlUiRoot, { recursive: true });
  const checkoutIndex = path.join(process.cwd(), "ui", "index.html");
  if (browserSessionClicks > 0) {
    const builtUi = path.join(process.cwd(), "dist", "control-ui");
    if (!existsSync(path.join(builtUi, "index.html"))) {
      throw new Error(
        "--browser-session-clicks requires built Control UI assets; run pnpm ui:build",
      );
    }
    cpSync(builtUi, controlUiRoot, { recursive: true });
  } else {
    copyFileSync(
      existsSync(checkoutIndex)
        ? checkoutIndex
        : path.join(process.cwd(), "dist", "control-ui", "index.html"),
      path.join(controlUiRoot, "index.html"),
    );
  }

  const config = structuredClone(BASE_GATEWAY_BENCH_CONFIG) as Record<string, unknown>;
  config.gateway = {
    ...(config.gateway as Record<string, unknown>),
    controlUi: { enabled: true, root: controlUiRoot },
  };
  applyMockOpenAiModelConfig(config, {
    mockPort,
    modelRef: "openai/gpt-5.6-luna",
    utilityModelRef: `openai/${UTILITY_MODEL_ID}`,
  });
  const agents = config.agents as Record<string, unknown>;
  agents.defaults = {
    ...(agents.defaults as Record<string, unknown>),
    maxConcurrent: concurrency,
    heartbeat: { every: "0m" },
  };
  const pluginFixtures =
    pluginCount > 0 ? writePluginFixtures(root, { count: pluginCount }) : undefined;
  const agentList =
    agentIds.length > 1
      ? agentIds.map((id, index) => {
          const workspace = path.join(root, `workspace-${id}`);
          mkdirSync(workspace, { recursive: true });
          return { id, default: index === 0, workspace };
        })
      : undefined;
  return writeGatewayBenchConfig(root, config, { agentList, pluginFixtures });
}

async function readGatewayProtocolVersion(entry: string): Promise<number> {
  const protocolPath = path.join(
    path.dirname(path.resolve(entry)),
    "gateway",
    "protocol",
    "index.js",
  );
  const protocol: unknown = await import(pathToFileURL(protocolPath).href);
  if (
    typeof protocol !== "object" ||
    protocol === null ||
    !("PROTOCOL_VERSION" in protocol) ||
    typeof protocol.PROTOCOL_VERSION !== "number"
  ) {
    throw new Error(`Gateway protocol module is missing PROTOCOL_VERSION: ${protocolPath}`);
  }
  return protocol.PROTOCOL_VERSION;
}

async function connectGateway(
  port: number,
  deadlineAt: number,
  protocolVersion: number,
  subscribeSessions = true,
  onEvent?: Parameters<typeof createGatewayWsClient>[0]["onEvent"],
) {
  let requestDeadlineAt = deadlineAt;
  const client = createGatewayWsClient({
    handshakeTimeoutMs: Math.min(8_000, requireRemainingMs(deadlineAt, "connecting WebSocket")),
    openTimeoutMs: Math.min(8_000, requireRemainingMs(deadlineAt, "opening WebSocket")),
    url: `ws://127.0.0.1:${port}`,
    onEvent,
  });
  await client.waitOpen();

  const requestRpc = async <T>(
    method: string,
    params: unknown,
    requestedTimeoutMs?: number,
  ): Promise<T> => {
    const response = await client.request(
      method,
      params,
      Math.max(
        1,
        Math.min(
          requestedTimeoutMs ?? 65_000,
          requireRemainingMs(requestDeadlineAt, `waiting for ${method}`),
        ),
      ),
    );
    if (!response.ok) {
      const message =
        response.error && typeof response.error === "object" && "message" in response.error
          ? String(response.error.message)
          : JSON.stringify(response.error);
      throw new Error(`${method} failed: ${message}`);
    }
    return response.payload as T;
  };

  await requestRpc("connect", {
    minProtocol: protocolVersion,
    maxProtocol: protocolVersion,
    client: {
      id: "gateway-client",
      displayName: "gateway-concurrency-benchmark",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
  });
  if (subscribeSessions) {
    await requestRpc("sessions.subscribe", {});
  }
  return {
    close: client.close,
    waitClosed: () =>
      new Promise<void>((resolve, reject) => {
        if (client.ws.readyState === client.ws.CLOSED) {
          resolve();
          return;
        }
        const onClose = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          client.ws.off("close", onClose);
          reject(new Error("benchmark event client did not close"));
        }, HTTP_TIMEOUT_MS);
        timer.unref();
        client.ws.once("close", onClose);
      }),
    request: requestRpc,
    setDeadlineAt: (value: number) => {
      requestDeadlineAt = value;
    },
  };
}

function readGatewayProcessRssMb(pid: number | undefined): number | null {
  if (!pid) {
    return null;
  }
  if (process.platform !== "linux") {
    return readProcessRssMb(pid);
  }
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    const rssKb = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(rssKb) && rssKb > 0 ? rssKb / 1024 : null;
  } catch {
    return null;
  }
}

async function timeRpcProbe(
  rpc: GatewayRpc,
  method: string,
  params: unknown,
  runStartedAt: number,
): Promise<TimedProbe> {
  const startedAt = performance.now();
  try {
    await rpc(method, params);
    return {
      atMs: startedAt - runStartedAt,
      error: null,
      latencyMs: performance.now() - startedAt,
      ok: true,
    };
  } catch (error) {
    return {
      atMs: startedAt - runStartedAt,
      error: describeProbeError(error),
      latencyMs: performance.now() - startedAt,
      ok: false,
    };
  }
}

function readProviderRequestLog(file: string): string[] {
  // A live append may have an incomplete final record. Its producer ordinal belongs to the next snapshot.
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(0, -1) : [];
}

function summarizeProviderRequests(
  lines: string[],
  beforeLoad: number,
  afterLoad: number,
  warmup?: { beforeOrdinal: number; afterOrdinal: number },
) {
  if (beforeLoad < 0 || beforeLoad > afterLoad || afterLoad > lines.length) {
    throw new Error("mock provider request snapshots are out of order");
  }
  if (
    warmup &&
    (warmup.beforeOrdinal < 0 ||
      warmup.beforeOrdinal > warmup.afterOrdinal ||
      warmup.afterOrdinal > beforeLoad)
  ) {
    throw new Error("mock provider warmup snapshots are out of order");
  }
  const createPhase = () => ({
    total: 0,
    inference: 0,
    byEndpoint: {} as Record<string, number>,
    requestBytes: 0,
    unknownRequestBytes: 0,
    bytesByEndpoint: {} as Record<string, number>,
    bytesByPurpose: { "activity-recap": 0, "session-observer": 0, "benchmark-turn": 0, other: 0 },
    byPurpose: { "activity-recap": 0, "session-observer": 0, "benchmark-turn": 0, other: 0 },
  });
  const phases = {
    warmup: createPhase(),
    setup: createPhase(),
    load: createPhase(),
    afterLoad: createPhase(),
  };
  const turns = new Map<number, { withoutToolOutput: number; withToolOutput: number }>();
  let unboundInference = 0;
  const loadContinuations = { withPreviousResponse: 0, withToolOutput: 0, unboundToolOutput: 0 };
  for (const [index, line] of lines.entries()) {
    const record = JSON.parse(line) as {
      seq: number;
      method: string;
      path: string;
      body: unknown;
      requestBytes?: number;
      inferenceFacts?: MockInferenceFacts;
    };
    if (record.seq !== index + 1) {
      throw new Error("mock provider request log has a missing or repeated ordinal");
    }
    const phase =
      warmup && record.seq > warmup.beforeOrdinal && record.seq <= warmup.afterOrdinal
        ? phases.warmup
        : record.seq <= beforeLoad
          ? phases.setup
          : record.seq <= afterLoad
            ? phases.load
            : phases.afterLoad;
    const endpoint = `${record.method} ${record.path}`;
    const bytes = record.requestBytes;
    const knownBytes = typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0;
    phase.requestBytes += knownBytes ? bytes : 0;
    phase.unknownRequestBytes += Number(!knownBytes);
    phase.bytesByEndpoint[endpoint] =
      (phase.bytesByEndpoint[endpoint] ?? 0) + (knownBytes ? bytes : 0);
    phase.total += 1;
    phase.byEndpoint[endpoint] = (phase.byEndpoint[endpoint] ?? 0) + 1;
    if (
      record.method !== "POST" ||
      !["/v1/responses", "/v1/chat/completions"].includes(record.path)
    ) {
      continue;
    }
    phase.inference += 1;
    let body: unknown;
    // The mock intentionally replaces oversized or unparseable bodies with bounded evidence.
    // Keep those arrivals in the denominator even when a turn marker cannot be recovered.
    if (typeof record.body === "string") {
      try {
        body = JSON.parse(record.body);
      } catch {
        body = undefined;
      }
    }
    const facts = record.inferenceFacts ?? summarizeMockInferenceRequest(body);
    phase.byPurpose[facts.purpose] += 1;
    phase.bytesByPurpose[facts.purpose] += knownBytes ? bytes : 0;
    if (phase !== phases.load) {
      continue;
    }
    loadContinuations.withPreviousResponse += Number(facts.hasPreviousResponse);
    loadContinuations.withToolOutput += Number(facts.hasToolOutput);
    const turnIndex = facts.benchmarkPhase === "load" ? facts.turnIndex : undefined;
    if (turnIndex === undefined) {
      loadContinuations.unboundToolOutput += Number(facts.hasToolOutput);
      unboundInference += 1;
      continue;
    }
    const turn = turns.get(turnIndex) ?? { withoutToolOutput: 0, withToolOutput: 0 };
    turn[facts.hasToolOutput ? "withToolOutput" : "withoutToolOutput"] += 1;
    turns.set(turnIndex, turn);
  }
  return {
    scope:
      "complete request records observed at snapshots outside the timed load; arrivals, not HTTP completion status",
    beforeLoadOrdinal: beforeLoad,
    afterLoadOrdinal: afterLoad,
    ...phases,
    loadTurns: [...turns]
      .toSorted(([left], [right]) => left - right)
      .map(([turnIndex, counts]) => ({
        turnIndex,
        withoutToolOutput: counts.withoutToolOutput,
        withToolOutput: counts.withToolOutput,
      })),
    loadPurposes: phases.load.byPurpose,
    loadContinuations,
    unboundLoadInference: unboundInference,
    unclassifiedLoadInference: phases.load.byPurpose.other,
  };
}

async function runTurn(
  rpc: GatewayRpc,
  index: number,
  deadlineAt: number,
  toolEvents = false,
  options?: {
    onStarted?: () => void;
    warmup?: boolean;
    sessionKey?: string;
    accounting?: BenchmarkRun["turnAccounting"];
    evidence?: ReturnType<typeof createTurnEvidence>;
  },
): Promise<void> {
  const requestedRunId = randomUUID();
  const sessionKey = options?.sessionKey ?? `agent:main:gateway-concurrency-${index + 1}`;
  const evidence = options?.evidence ?? createTurnEvidence(toolEvents);
  evidence.register(requestedRunId, sessionKey, options?.warmup ? "warmup" : "load");
  if (options?.accounting) {
    options.accounting.launched += 1;
  }
  const started = await rpc<{ runId?: string; status?: string }>("agent", {
    sessionKey,
    message: toolEvents
      ? `${TOOL_SUCCESS_MARKER} benchmark ${options?.warmup ? "warmup " : ""}tool stream ${index + 1}.`
      : `Reply with benchmark ${options?.warmup ? "warmup " : ""}stream ${index + 1}.`,
    deliver: false,
    idempotencyKey: requestedRunId,
  });
  options?.onStarted?.();
  if (options?.evidence && started.runId !== undefined && started.runId !== requestedRunId) {
    throw new Error("agent returned a different benchmark run identity");
  }
  if (started.status !== "accepted" && started.status !== "ok") {
    throw new Error(`agent ${index + 1} was not accepted: ${JSON.stringify(started)}`);
  }
  const remaining = requireRemainingMs(deadlineAt, `waiting for agent ${index + 1} completion`);
  // Agent waits share the load deadline; a shorter observation cap would abort
  // an active turn while the benchmark still has time to measure completion.
  const waitTimeoutMs = Math.max(0, Math.floor(remaining - AGENT_WAIT_RPC_GRACE_MS));
  const rpcTimeoutMs = Math.max(1, Math.ceil(remaining));
  const runId = started.runId ?? requestedRunId;
  const completed = await rpc<
    Awaited<ReturnType<ReturnType<typeof createAgentTurnService>["waitForTurn"]>>["result"]
  >(
    "agent.wait",
    {
      runId,
      timeoutMs: waitTimeoutMs,
    },
    rpcTimeoutMs,
  );
  if (completed.status !== "ok") {
    throw new Error(`agent ${index + 1} did not complete: ${JSON.stringify(completed)}`);
  }
  if (options?.accounting) {
    options.accounting.terminalOk += 1;
  }
  if (completed.runId !== runId) {
    throw new Error("agent.wait returned a different or missing benchmark run identity");
  }
  const receipt = completed.terminalReceipt;
  const reply = completed.terminalReply;
  if (
    completed.error ||
    completed.pendingError ||
    completed.yielded ||
    receipt?.runId !== runId ||
    !receipt.sessionId ||
    !receipt.turnId ||
    receipt.rerouted ||
    receipt.terminalDisposition !== "visible" ||
    receipt.effective.provider !== "openai" ||
    receipt.effective.model !== "gpt-5.6-luna" ||
    reply?.disposition !== "visible" ||
    reply.text !== (toolEvents ? TOOL_SUCCESS_MARKER : STREAM_SUCCESS_MARKER) ||
    (toolEvents && !receipt.successfulToolNames.includes("exec"))
  ) {
    throw new Error(`agent ${index + 1} terminal evidence failed: ${JSON.stringify(completed)}`);
  }
  if (toolEvents) {
    evidence.complete(requestedRunId, completed.terminalReply);
  }
  if (options?.accounting) {
    options.accounting.verified += 1;
  }
}

async function runSessionTurns(
  rpc: GatewayRpc,
  index: number,
  deadlineAt: number,
  options: {
    onStarted?: () => void;
    warmup?: boolean;
    sessionKey: string;
    toolEvents: boolean;
    turnsPerSession: number;
    evidence?: ReturnType<typeof createTurnEvidence>;
    accounting?: BenchmarkRun["turnAccounting"];
  },
): Promise<number> {
  for (let turn = 0; turn < options.turnsPerSession; turn += 1) {
    requireRemainingMs(deadlineAt, `starting session ${index + 1} turn ${turn + 1}`);
    await runTurn(rpc, index * options.turnsPerSession + turn, deadlineAt, options.toolEvents, {
      sessionKey: options.sessionKey,
      warmup: options.warmup,
      accounting: options.accounting,
      onStarted: turn === 0 ? options.onStarted : undefined,
      evidence: options.evidence,
    });
  }
  return options.turnsPerSession;
}

async function sampleGateway(params: {
  deadlineAt: number;
  port: number;
  rpc: GatewayRpc;
  runStartedAt: number;
  serial?: boolean;
}): Promise<GatewaySample> {
  const atMs = performance.now() - params.runStartedAt;
  const safeHttpProbe = async (pathValue: string, accept: string) => {
    const startedAt = performance.now();
    try {
      return {
        ...(await requestHttp({
          accept,
          deadlineAt: params.deadlineAt,
          path: pathValue,
          port: params.port,
        })),
        error: null,
        ok: true,
      };
    } catch (error) {
      return {
        body: "",
        error: describeProbeError(error),
        latencyMs: performance.now() - startedAt,
        ok: false,
        status: 0,
      };
    }
  };
  const probeReadyz = () => safeHttpProbe("/readyz", "application/json");
  const probeControlUi = () => safeHttpProbe("/", "text/html");
  const probeSessions = async () => {
    const startedAt = performance.now();
    try {
      const payload = await params.rpc(
        "sessions.list",
        {},
        Math.min(HTTP_TIMEOUT_MS, requireRemainingMs(params.deadlineAt, "probing sessions.list")),
      );
      return { error: null, latencyMs: performance.now() - startedAt, ok: true, payload };
    } catch (error) {
      return {
        error: describeProbeError(error),
        latencyMs: performance.now() - startedAt,
        ok: false,
        payload: null,
      };
    }
  };
  const [readyz, controlUi, sessions] = params.serial
    ? [await probeReadyz(), await probeControlUi(), await probeSessions()]
    : await Promise.all([probeReadyz(), probeControlUi(), probeSessions()]);
  const readyBody = (() => {
    if (readyz.status !== 200) {
      return {};
    }
    try {
      return JSON.parse(readyz.body) as { eventLoop?: Record<string, unknown> };
    } catch {
      return {};
    }
  })();
  const eventLoop = readyBody.eventLoop;
  return {
    controlUi: {
      atMs,
      error:
        controlUi.error ??
        (controlUi.status === 200 && !controlUi.body.includes("<html")
          ? "response body did not contain <html"
          : null),
      latencyMs: controlUi.latencyMs,
      ok: controlUi.ok && controlUi.status === 200 && controlUi.body.includes("<html"),
      status: controlUi.status,
    },
    readyz: {
      atMs,
      error: readyz.error,
      latencyMs: readyz.latencyMs,
      ok: readyz.ok && readyz.status === 200,
      status: readyz.status,
      degraded: typeof eventLoop?.degraded === "boolean" ? eventLoop.degraded : null,
      degradedSinceMs: asFiniteNumber(eventLoop?.degradedSinceMs) ?? null,
      delayP99Ms: asFiniteNumber(eventLoop?.delayP99Ms) ?? null,
      delayMaxMs: asFiniteNumber(eventLoop?.delayMaxMs) ?? null,
      utilization: asFiniteNumber(eventLoop?.utilization) ?? null,
      cpuCoreRatio: asFiniteNumber(eventLoop?.cpuCoreRatio) ?? null,
    },
    sessionsList: {
      atMs,
      error: sessions.error,
      latencyMs: sessions.latencyMs,
      ok: sessions.ok,
    },
  };
}

async function warmGatewayProbes(params: {
  deadlineAt: number;
  sample: (deadlineAt: number) => Promise<GatewaySample>;
  retryDelayMs?: number;
  targetMs?: number;
}): Promise<{ durationMs: number; samples: GatewaySample[] }> {
  const startedAt = performance.now();
  const samples: GatewaySample[] = [];
  const targetMs = params.targetMs ?? PROBE_WARMUP_TARGET_MS;
  while (remainingMs(params.deadlineAt) > 0) {
    const sample = await params.sample(params.deadlineAt);
    samples.push(sample);
    const healthy = sample.readyz.ok && sample.sessionsList.ok && sample.controlUi.ok;
    const fast =
      Math.max(
        sample.readyz.latencyMs,
        sample.sessionsList.latencyMs,
        sample.controlUi.latencyMs,
      ) <= targetMs;
    const eventLoopSettled = sample.readyz.degraded !== true;
    if (healthy && fast && eventLoopSettled) {
      return { durationMs: performance.now() - startedAt, samples };
    }
    await delay(
      Math.min(params.retryDelayMs ?? PROBE_WARMUP_RETRY_DELAY_MS, remainingMs(params.deadlineAt)),
    );
  }
  const lastSample = samples.at(-1);
  throw new Error(
    lastSample
      ? formatProbeFailure(lastSample)
      : "gateway probes did not run before the warmup deadline",
  );
}

async function runProbeRounds(params: {
  rounds?: number;
  deadlineAt: number;
  cadenceMs: number;
  cadenceFrom: "start" | "completion";
  runFirst: boolean;
  shouldContinue: () => boolean;
  stopped: () => boolean;
  runRound: (index: number) => Promise<void>;
}): Promise<number> {
  let completed = 0;
  const hasWork = () =>
    !params.stopped() &&
    (params.rounds === undefined
      ? (completed === 0 && params.runFirst) || params.shouldContinue()
      : completed < params.rounds);
  while (hasWork()) {
    requireRemainingMs(params.deadlineAt, "starting gateway probe round");
    const startedAt = performance.now();
    await params.runRound(completed);
    completed += 1;
    if (!hasWork()) {
      break;
    }
    const elapsed = params.cadenceFrom === "start" ? performance.now() - startedAt : 0;
    await delay(
      Math.min(
        Math.max(0, params.cadenceMs - elapsed),
        requireRemainingMs(params.deadlineAt, "pacing gateway probes"),
      ),
    );
  }
  return completed;
}

async function runGatewaySample(options: {
  agentCount: number;
  agentWarmupTurns: number;
  gatewayCpus?: string;
  browserHistoryMessages: number;
  browserSessionClicks: number;
  cadenceMs: number;
  concurrency: number;
  controlPlane: boolean;
  deadlineAt: number;
  diagnosticsTimeline: boolean;
  entry: string;
  cpuProfDir?: string;
  loadCpuProfDir?: string;
  heapProfDir?: string;
  historyBurst: number;
  historyClients: number;
  historyMessages: number;
  historyMessageChars: number;
  pluginCount: number;
  probeRounds?: number;
  sessionCount: number;
  sessionUpdateClients: number;
  sessionUpdates: number;
  streamChunkDelayMs: number;
  subscribers: number;
  timeoutMs: number;
  toolEvents: boolean;
  turnsPerSession: number;
  visibleObserver: boolean;
  workspaceFanout: boolean;
}): Promise<BenchmarkRun> {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-gateway-concurrency-"));
  const [port, mockPort] = await Promise.all([getFreePort(), getFreePort()]);
  const runStartedAt = performance.now();
  const agentIds = Array.from({ length: options.agentCount }, (_, index) =>
    index === 0 ? "main" : `bench-agent-${index + 1}`,
  );
  const timelinePath = path.join(root, "diagnostics-timeline.jsonl");
  const requestLogPath = path.join(root, "mock-provider-requests.jsonl");
  const responseControlPath = path.join(root, "mock-provider-responses.json");
  const heapProfilePath = options.heapProfDir
    ? path.resolve(options.heapProfDir, `gateway-load-${randomUUID()}.heapprofile`)
    : undefined;
  const loadCpuProfilePath = options.loadCpuProfDir
    ? path.resolve(options.loadCpuProfDir, `gateway-load-${randomUUID()}.cpuprofile`)
    : undefined;
  const protocolVersion = await readGatewayProtocolVersion(options.entry);
  let gateway: ChildProcess | undefined;
  let mockProvider: ChildProcessWithoutNullStreams | undefined;
  let client: Awaited<ReturnType<typeof connectGateway>> | undefined;
  let browserProbe: Awaited<ReturnType<typeof startGatewayBrowserProbe>> | undefined;
  const auxiliaryClients: Array<Awaited<ReturnType<typeof connectGateway>>> = [];
  let probesStopped = false;
  const probeJobs: Promise<unknown>[] = [];
  let gatewayOutput = { readOutput: () => "", readStderrTail: () => "" };
  let mockOutput = { readOutput: () => "", readStderrTail: () => "" };
  let result: Omit<
    BenchmarkRun,
    "mockRequests" | "turnEvidence" | "providerRequests" | "agentWarmup"
  >;
  const mockCheckpoints: MockRequestSnapshot[] = [];
  const turnEvidence = createTurnEvidence(options.toolEvents);
  let gatewayExit: Awaited<ReturnType<typeof stopChild>> | undefined;
  let gatewayExitEvent: GatewayChildExit | undefined;
  let gatewayCloseEvent: GatewayChildExit | undefined;
  const readGatewayProcess = () => ({
    pid: gateway?.pid,
    exitCode: gateway?.exitCode,
    signalCode: gateway?.signalCode,
    exitEvent: gatewayExitEvent,
    closeEvent: gatewayCloseEvent,
  });
  let timelineWindow: { from: number; through: number } | undefined;
  const turnAccounting = { launched: 0, terminalOk: 0, verified: 0 };
  const agentWarmup = {
    durationMs: 0,
    launched: 0,
    terminalOk: 0,
    verified: 0,
    beforeOrdinal: 0,
    afterOrdinal: 0,
  };
  let providerBeforeLoad: number | undefined;
  let providerAfterLoad: number | undefined;

  try {
    try {
      const configPath = buildConfig(
        root,
        mockPort,
        options.concurrency,
        options.pluginCount,
        options.browserSessionClicks,
        agentIds,
      );
      writeFileSync(
        responseControlPath,
        JSON.stringify({
          models: {
            [UTILITY_MODEL_ID]: {
              text: JSON.stringify({
                headline: "Synthetic benchmark work is progressing.",
                assessment: OBSERVER_ASSESSMENT,
                health: "on-track",
              }),
            },
          },
        }),
      );
      mockProvider = spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env: {
          LANG: process.env.LANG ?? "en_US.UTF-8",
          PATH: process.env.PATH,
          MOCK_PORT: String(mockPort),
          MOCK_RESPONSE_CONTROL: responseControlPath,
          MOCK_REQUEST_LOG: requestLogPath,
          MOCK_RESPONSE_CHUNK_DELAY_MS: String(options.streamChunkDelayMs),
          SUCCESS_MARKER: STREAM_SUCCESS_MARKER,
        },
      });
      await once(mockProvider, "spawn");
      mockOutput = captureChildOutput(mockProvider);
      await waitForMockServer(mockPort, options.deadlineAt);
      mockCheckpoints.push(await readMockRequests(mockPort, options.deadlineAt));

      if (options.cpuProfDir) {
        mkdirSync(options.cpuProfDir, { recursive: true });
      }
      const gatewayArgs = buildGatewayBenchChildArgs(options.entry, port);
      gatewayArgs.unshift(
        "--import",
        new URL("./lib/gateway-bench-profile-preload.ts", import.meta.url).href,
      );
      if (heapProfilePath || loadCpuProfilePath) {
        for (const profilePath of [heapProfilePath, loadCpuProfilePath]) {
          if (profilePath) {
            mkdirSync(path.dirname(profilePath), { recursive: true });
          }
        }
      }
      if (options.gatewayCpus && process.platform !== "linux") {
        throw new Error("--gateway-cpus requires Linux taskset");
      }
      const profiledArgs = options.cpuProfDir
        ? ["--cpu-prof", `--cpu-prof-dir=${options.cpuProfDir}`, ...gatewayArgs]
        : gatewayArgs;
      gateway = spawn(
        options.gatewayCpus ? "taskset" : process.execPath,
        options.gatewayCpus
          ? ["--cpu-list", options.gatewayCpus, process.execPath, ...profiledArgs]
          : profiledArgs,
        {
          cwd: process.cwd(),
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: {
            ...createGatewayBenchEnv(root, configPath, {
              caseEnv: {
                ...(options.diagnosticsTimeline
                  ? {
                      OPENCLAW_DIAGNOSTICS: "timeline",
                      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
                    }
                  : {}),
                OPENCLAW_SKIP_CHANNELS: "1",
              },
            }),
            OPENAI_API_KEY: "gateway-concurrency-benchmark",
          },
        },
      );
      gateway.once("exit", (exitCode, signal) => {
        gatewayExitEvent = {
          atMonotonicMicros: Number(process.hrtime.bigint() / 1_000n),
          exitCode,
          signal,
        };
      });
      gateway.once("close", (exitCode, signal) => {
        gatewayCloseEvent = {
          atMonotonicMicros: Number(process.hrtime.bigint() / 1_000n),
          exitCode,
          signal,
        };
      });
      // A failed launch emits error instead of exit; reject into teardown before polling readiness.
      await once(gateway, "spawn");
      gatewayOutput = captureChildOutput(gateway);
      const ready = await waitForInitialProbe({
        deadlineAt: options.deadlineAt,
        isDone: () => gateway?.exitCode != null || gateway?.signalCode != null,
        path: "/readyz",
        port,
        startAt: runStartedAt,
      });
      if (ready.status !== 200) {
        throw new Error(`gateway did not become ready\n${gatewayOutput.readOutput()}`);
      }
      await waitForGatewayDispatchReady(gatewayOutput.readOutput, options.deadlineAt);
      client = await connectGateway(
        port,
        options.deadlineAt,
        protocolVersion,
        true,
        turnEvidence.onEvent,
      );
      const rpc = client.request;
      if (options.visibleObserver) {
        await rpc("sessions.observer.visibility", { visible: true });
      }
      // The first authenticated RPC lazily imports the server-method graph. It measured 6.9s
      // on an idle M4 Pro (previously 18.4s) and crossed 20s on Linux; hot probes took 15-40ms.
      // Keep that cold work out of the load-phase deadline and latency distributions.
      const probeWarmupDeadlineAt = performance.now() + PROBE_WARMUP_TIMEOUT_MS;
      client.setDeadlineAt(probeWarmupDeadlineAt);
      const probeWarmup = await warmGatewayProbes({
        deadlineAt: probeWarmupDeadlineAt,
        sample: (deadlineAt) =>
          sampleGateway({
            deadlineAt,
            port,
            rpc,
            runStartedAt,
          }),
      });
      const setupDeadlineAt = performance.now() + options.timeoutMs;
      const setupStartedAt = performance.now();
      mockCheckpoints.push(await readMockRequests(mockPort, setupDeadlineAt));
      client.setDeadlineAt(setupDeadlineAt);
      const sessionCount = Math.max(options.concurrency, options.sessionCount);
      const prepareSessions =
        options.agentCount > 1 ||
        options.browserSessionClicks > 0 ||
        options.workspaceFanout ||
        options.sessionCount > 0 ||
        options.historyClients > 0 ||
        options.historyMessages > 0 ||
        options.sessionUpdates > 0 ||
        options.subscribers > 0;
      const sessionAgents = Array.from(
        { length: sessionCount },
        (_, index) => agentIds[index % agentIds.length]!,
      );
      const sessionKeys = sessionAgents.map(
        (agentId, index) => `agent:${agentId}:gateway-concurrency-${index + 1}`,
      );
      const sessionSeedStartedAt = performance.now();
      if (prepareSessions) {
        let nextSessionIndex = 0;
        let seededSessionCount = 0;
        await Promise.all(
          Array.from({ length: Math.min(MAX_SESSION_SEED_CONCURRENCY, sessionCount) }, async () => {
            for (;;) {
              const index = nextSessionIndex++;
              const sessionKey = sessionKeys[index];
              if (!sessionKey) {
                return;
              }
              const workspaceDir = options.workspaceFanout
                ? path.join(root, `workspace-${index + 1}`)
                : undefined;
              if (workspaceDir) {
                mkdirSync(workspaceDir, { recursive: true });
              }
              await rpc("sessions.create", {
                key: sessionKey,
                agentId: sessionAgents[index],
                ...(workspaceDir ? { cwd: workspaceDir } : {}),
              });
              for (
                let messageIndex = 0;
                messageIndex < options.historyMessages;
                messageIndex += 1
              ) {
                const marker = `Synthetic history ${index + 1}/${messageIndex + 1}. `;
                const message = marker
                  .repeat(Math.ceil(options.historyMessageChars / marker.length))
                  .slice(0, options.historyMessageChars);
                await rpc("chat.inject", { sessionKey, message });
              }
              seededSessionCount += 1;
              if (sessionCount >= 250 && seededSessionCount % 250 === 0) {
                console.error(
                  `[bench-gateway-concurrency] seeded ${seededSessionCount}/${sessionCount} sessions`,
                );
              }
            }
          }),
        );
      }
      const sessionSeedDurationMs = performance.now() - sessionSeedStartedAt;
      const browserTargets: BrowserSessionTarget[] = [];
      const browserHistoryMessages = options.browserHistoryMessages;
      if (options.browserSessionClicks > 0) {
        for (let index = 0; index <= options.browserSessionClicks; index += 1) {
          const target = {
            key: `agent:main:sidebar-click-${index}`,
            marker: `Sidebar click history ${index}.`,
          };
          await rpc("sessions.create", { key: target.key, agentId: "main" });
          for (let message = 0; message < browserHistoryMessages; message += 1) {
            const prefix = `## Synthetic message ${message + 1}\n\n${target.marker}\n\n`;
            const messageText =
              prefix +
              "Synthetic **benchmark** paragraph. "
                .repeat(Math.ceil(options.historyMessageChars / 35))
                .slice(0, Math.max(0, options.historyMessageChars - prefix.length));
            await rpc("chat.inject", { sessionKey: target.key, message: messageText });
          }
          browserTargets.push(target);
        }
        browserProbe = await startGatewayBrowserProbe({
          port,
          timeoutMs: requireRemainingMs(setupDeadlineAt, "opening browser"),
          initial: browserTargets[0]!,
          visibleSessions: options.concurrency + browserTargets.length,
        });
      }
      let browserInventory: NonNullable<BenchmarkRun["browser"]>["inventory"] | undefined;
      if (browserProbe) {
        const [unarchived, retained] = await Promise.all([
          rpc<{ totalCount: number }>("sessions.list", { limit: 1, archived: false }),
          rpc<{ totalCount: number }>("sessions.list", { limit: 1, archived: "all" }),
        ]);
        browserInventory = {
          seededLoadSessions: sessionCount,
          seededClickSessions: browserTargets.length,
          unarchivedSessions: unarchived.totalCount,
          retainedSessions: retained.totalCount,
        };
      }
      // Normal inventory maintenance can archive older fixture sessions while seeding.
      // Active turns and observers use the newest sessions; history still spans the inventory.
      const turnSessionKeys = sessionKeys.slice(-options.concurrency);
      const turnAgentIds = sessionAgents.slice(-options.concurrency);
      const agentCoverage: BenchmarkRun["agentCoverage"] =
        options.agentCount > 1
          ? {
              configuredAgentIds: agentIds,
              activeTurnAgentIds: [...new Set(turnAgentIds)],
              beforeLoad: [],
              completedTurns: [],
            }
          : undefined;
      if (agentCoverage) {
        for (const agentId of agentIds) {
          // Require published runtime facts before measuring the configured roster.
          const models = await rpc<ModelsListResult>("models.list", {
            agentId,
            view: "configured",
            refresh: false,
          });
          if (
            ["gpt-5.6-luna", UTILITY_MODEL_ID].some(
              (id) =>
                !models.models.some((model) => model.provider === "openai" && model.id === id),
            )
          ) {
            throw new Error(`Configured benchmark model is not published for ${agentId}`);
          }
          const storePath = path.join(
            root,
            "state",
            "agents",
            agentId,
            "agent",
            "openclaw-agent.sqlite",
          );
          const sessions: SessionsListResult[] = [];
          let offset = 0;
          for (;;) {
            const page = await rpc<SessionsListResult>("sessions.list", {
              agentId,
              archived: "all",
              limit: 1_000,
              offset,
            });
            if (page.path !== storePath || page.count !== page.sessions.length) {
              throw new Error(`Benchmark session store or page mismatch for ${agentId}`);
            }
            sessions.push(page);
            if (!page.hasMore) {
              break;
            }
            if (
              !Number.isSafeInteger(page.nextOffset) ||
              page.nextOffset == null ||
              page.nextOffset <= offset ||
              page.nextOffset > sessionCount + browserTargets.length
            ) {
              throw new Error(`Benchmark session pagination did not advance for ${agentId}`);
            }
            offset = page.nextOffset;
          }
          const expectedKeys = sessionKeys.filter((_, index) => sessionAgents[index] === agentId);
          const observedRows = sessions.flatMap((page) =>
            page.sessions.filter((row) => row.key.includes(":gateway-concurrency-")),
          );
          const observedKeys = new Set(observedRows.map((row) => row.key));
          if (
            observedRows.length !== expectedKeys.length ||
            observedKeys.size !== expectedKeys.length ||
            observedRows.some((row) => row.agentId !== agentId) ||
            expectedKeys.some((key) => !observedKeys.has(key))
          ) {
            throw new Error(
              `Benchmark session inventory or distinct store mismatch for ${agentId}`,
            );
          }
          agentCoverage.beforeLoad.push({ agentId, models, sessions });
        }
      }
      const messageSubscriptions: TimedProbe[] = [];
      for (let index = 0; index < options.subscribers; index += 1) {
        const subscriber = await connectGateway(port, setupDeadlineAt, protocolVersion, false);
        auxiliaryClients.push(subscriber);
        if (options.visibleObserver) {
          await subscriber.request("sessions.observer.visibility", { visible: true });
        }
        const subscription = await timeRpcProbe(
          subscriber.request,
          "sessions.messages.subscribe",
          { key: turnSessionKeys[index % turnSessionKeys.length] },
          runStartedAt,
        );
        messageSubscriptions.push(subscription);
        if (!subscription.ok) {
          throw new Error(`session message subscription failed: ${subscription.error}`);
        }
      }
      const historyClients = await Promise.all(
        Array.from({ length: options.historyClients }, async () => {
          const historyClient = await connectGateway(port, setupDeadlineAt, protocolVersion, false);
          auxiliaryClients.push(historyClient);
          return historyClient;
        }),
      );
      const sessionUpdateClients = await Promise.all(
        Array.from(
          { length: options.sessionUpdates > 0 ? options.sessionUpdateClients : 0 },
          async () => {
            const updateClient = await connectGateway(
              port,
              setupDeadlineAt,
              protocolVersion,
              false,
            );
            auxiliaryClients.push(updateClient);
            return updateClient;
          },
        ),
      );
      const subscriptionProbeClient =
        options.subscribers > 0
          ? await connectGateway(port, setupDeadlineAt, protocolVersion, false)
          : undefined;
      if (subscriptionProbeClient) {
        auxiliaryClients.push(subscriptionProbeClient);
      }
      mockCheckpoints.push(await readMockRequests(mockPort, setupDeadlineAt));
      let preparedDeadlineAt = setupDeadlineAt;
      agentWarmup.beforeOrdinal = readProviderRequestLog(requestLogPath).length;
      const agentWarmupStartedAt = performance.now();
      if (options.agentWarmupTurns > 0) {
        const warmupDeadlineAt = performance.now() + options.timeoutMs;
        preparedDeadlineAt = warmupDeadlineAt;
        client.setDeadlineAt(warmupDeadlineAt);
        try {
          await Promise.all(
            turnSessionKeys.map((sessionKey, index) =>
              runSessionTurns(rpc, index, warmupDeadlineAt, {
                sessionKey,
                warmup: true,
                toolEvents: options.toolEvents,
                turnsPerSession: options.agentWarmupTurns,
                accounting: agentWarmup,
                evidence: turnEvidence,
              }),
            ),
          );
        } finally {
          agentWarmup.durationMs = performance.now() - agentWarmupStartedAt;
          agentWarmup.afterOrdinal = readProviderRequestLog(requestLogPath).length;
        }
      } else {
        agentWarmup.afterOrdinal = agentWarmup.beforeOrdinal;
      }
      // Warm turns exercise this Gateway's runtime; they do not prove background queues drained.
      const memoryBefore = await readGatewayMemory(rpc, runStartedAt);
      mockCheckpoints.push(await readMockRequests(mockPort, preparedDeadlineAt));
      if (loadCpuProfilePath) {
        await controlGatewayProfile(gateway, "cpu", "start", loadCpuProfilePath, {
          includeWorkers: true,
        });
      }
      if (heapProfilePath) {
        await controlGatewayProfile(gateway, "heap", "start", heapProfilePath, {
          includeWorkers: true,
        });
      }
      const setupDurationMs = performance.now() - setupStartedAt;
      // Large session fixtures are setup, not benchmarked load. Every measured
      // run therefore gets its complete timeout after all clients are ready.
      const loadDeadlineAt = performance.now() + options.timeoutMs;
      client.setDeadlineAt(loadDeadlineAt);
      for (const auxiliaryClient of auxiliaryClients) {
        auxiliaryClient.setDeadlineAt(loadDeadlineAt);
      }
      const controlPlane: BenchmarkRun["controlPlane"] = [];
      const controlUi: ControlUiProbe[] = [];
      const history: BenchmarkRun["history"] = [];
      const messageSubscriptionsDuringLoad: TimedProbe[] = [];
      const readyz: ReadyProbe[] = [];
      const sessionsList: TimedProbe[] = [];
      const sessionUpdates: TimedProbe[] = [];
      let peakRssMb = memoryBefore.rssMb;
      let lastRssSampleAt = performance.now();
      let turnsDone = false;
      let updatesDone = options.sessionUpdates === 0;
      let browserDone = !browserProbe;
      const workloadDone = () => turnsDone && updatesDone && browserDone;
      let startedTurnCount = 0;
      let resolveAllTurnsStarted!: () => void;
      const allTurnsStarted = new Promise<void>((resolve) => {
        resolveAllTurnsStarted = resolve;
      });
      providerBeforeLoad = readProviderRequestLog(requestLogPath).length;
      const processPlacement =
        process.platform === "linux" && mockProvider.pid
          ? {
              driver: {
                pid: process.pid,
                affinity: readFileSync("/proc/self/status", "utf8").match(
                  /^Cpus_allowed_list:\s*(.+)$/mu,
                )?.[1],
              },
              mockProvider: {
                pid: mockProvider.pid,
                affinity: readFileSync(`/proc/${mockProvider.pid}/status`, "utf8").match(
                  /^Cpus_allowed_list:\s*(.+)$/mu,
                )?.[1],
              },
            }
          : undefined;
      const cpuBefore = await readGatewayCpuUsage(gateway);
      const turnsStartedAt = performance.now();
      // Keep the live artifact intact: buffered setup writes can arrive after this boundary.
      // Inclusive millisecond timestamps conservatively include events on the boundary.
      const timelineFrom = Date.now();
      const loadStartMonotonicMicros = Number(process.hrtime.bigint() / 1_000n);
      const turns = Promise.all(
        turnSessionKeys.map((sessionKey, index) =>
          runSessionTurns(rpc, index, loadDeadlineAt, {
            onStarted: () => {
              startedTurnCount += 1;
              if (startedTurnCount === options.concurrency) {
                resolveAllTurnsStarted();
              }
            },
            sessionKey,
            toolEvents: options.toolEvents,
            turnsPerSession: options.turnsPerSession,
            evidence: turnEvidence,
            accounting: turnAccounting,
          }),
        ),
      ).finally(() => {
        turnsDone = true;
        resolveAllTurnsStarted();
      });
      const freshConnection = allTurnsStarted.then(async (): Promise<FreshConnectionProbe> => {
        const startedAt = performance.now();
        try {
          const freshClient = await connectGateway(port, loadDeadlineAt, protocolVersion, false);
          freshClient.close();
          return { error: null, latencyMs: performance.now() - startedAt, ok: true };
        } catch (error) {
          return {
            error: describeProbeError(error),
            latencyMs: performance.now() - startedAt,
            ok: false,
          };
        }
      });
      const browserClicks = allTurnsStarted.then(async (): Promise<BrowserSessionClick[]> => {
        try {
          if (!browserProbe) {
            return [];
          }
          const clicks: BrowserSessionClick[] = [];
          const targets = [...browserTargets.slice(1), browserTargets.at(-2)!];
          for (const [index, target] of targets.entries()) {
            clicks.push(
              await browserProbe.click(
                target,
                index === targets.length - 1,
                () => !turnsDone,
                Math.min(30_000, requireRemainingMs(loadDeadlineAt, "clicking sidebar session")),
              ),
            );
          }
          return clicks;
        } finally {
          browserDone = true;
        }
      });
      const sampler = runProbeRounds({
        rounds: options.probeRounds,
        deadlineAt: loadDeadlineAt,
        cadenceMs: options.cadenceMs,
        cadenceFrom: "start",
        runFirst: true,
        shouldContinue: () => !workloadDone() && readyz.length < MAX_SAMPLES_PER_RUN,
        stopped: () => probesStopped,
        runRound: async () => {
          const subscriptionKey = turnSessionKeys[readyz.length % turnSessionKeys.length];
          const [sample, subscription, controlProbes] = await Promise.all([
            sampleGateway({
              deadlineAt: loadDeadlineAt,
              port,
              rpc,
              runStartedAt,
            }),
            subscriptionProbeClient && subscriptionKey
              ? timeRpcProbe(
                  subscriptionProbeClient.request,
                  "sessions.messages.subscribe",
                  { key: subscriptionKey },
                  runStartedAt,
                )
              : Promise.resolve(undefined),
            options.controlPlane
              ? Promise.all(
                  ["tasks.list", "cron.list", "cron.status"].map(async (method) =>
                    Object.assign(await timeRpcProbe(rpc, method, {}, runStartedAt), { method }),
                  ),
                )
              : Promise.resolve([]),
          ]);
          controlPlane.push(...controlProbes);
          if (subscription) {
            messageSubscriptionsDuringLoad.push(subscription);
            if (subscription.ok) {
              await subscriptionProbeClient?.request("sessions.messages.unsubscribe", {
                key: subscriptionKey,
              });
            }
          }
          readyz.push(sample.readyz);
          sessionsList.push(sample.sessionsList);
          controlUi.push(sample.controlUi);
          if (performance.now() - lastRssSampleAt >= 1_000) {
            // Linux reads procfs without spawning a process. Non-Linux hosts use
            // the shared ps fallback at most once per second to bound perturbation.
            peakRssMb = Math.max(peakRssMb, readGatewayProcessRssMb(gateway?.pid) ?? 0);
            lastRssSampleAt = performance.now();
          }
        },
      });
      probeJobs.push(sampler);
      const historyLoad = Promise.all(
        historyClients.map((historyClient, clientIndex) => {
          let offset = clientIndex * options.historyBurst;
          const job = runProbeRounds({
            rounds: options.probeRounds,
            deadlineAt: loadDeadlineAt,
            cadenceMs: options.cadenceMs,
            cadenceFrom: "completion",
            runFirst: false,
            shouldContinue: () => !workloadDone() && history.length < MAX_SAMPLES_PER_RUN,
            stopped: () => probesStopped,
            runRound: async () => {
              const probes = await Promise.all(
                Array.from({ length: options.historyBurst }, (_, index) => {
                  const sessionKey = sessionKeys[(offset + index) % sessionKeys.length]!;
                  const probe = timeRpcProbe(
                    historyClient.request,
                    "chat.history",
                    { sessionKey },
                    runStartedAt,
                  );
                  return agentCoverage
                    ? probe.then((sample) => ({ ...sample, sessionKey }))
                    : probe;
                }),
              );
              history.push(...probes);
              offset += options.historyBurst;
            },
          });
          probeJobs.push(job);
          return job;
        }),
      );
      let nextUpdateIndex = 0;
      const sessionUpdateLoad = Promise.all(
        sessionUpdateClients.map(async (updateClient) => {
          for (;;) {
            const index = nextUpdateIndex++;
            if (index >= options.sessionUpdates) {
              return;
            }
            const sessionKey = sessionKeys[index % sessionKeys.length];
            const update = await timeRpcProbe(
              updateClient.request,
              "sessions.patch",
              { key: sessionKey, label: `Benchmark update ${index + 1}` },
              runStartedAt,
            );
            sessionUpdates.push(update);
            if (!update.ok) {
              throw new Error(`sessions.patch load probe failed: ${update.error}`);
            }
          }
        }),
      ).finally(() => {
        updatesDone = true;
      });
      const [freshConnectionResult, sessionTurnCounts, browserClickResults] = await Promise.all([
        freshConnection,
        turns,
        browserClicks,
        sampler,
        historyLoad,
        sessionUpdateLoad,
      ]);
      const cpuAfter = await readGatewayCpuUsage(gateway);
      const loadEndMonotonicMicros = Number(process.hrtime.bigint() / 1_000n);
      const turnsDurationMs = performance.now() - turnsStartedAt;
      providerAfterLoad = readProviderRequestLog(requestLogPath).length;
      const memoryAfter = await readGatewayMemory(rpc, runStartedAt);
      timelineWindow = { from: timelineFrom, through: Date.now() };
      let loadCpuProfile: BenchmarkRun["loadCpuProfile"];
      if (loadCpuProfilePath) {
        await controlGatewayProfile(gateway, "cpu", "stop", loadCpuProfilePath);
        loadCpuProfile = {
          ...readGatewayCpuProfile(loadCpuProfilePath),
          scope: "main-isolate",
          workersManifestPath: `${loadCpuProfilePath}.workers.json`,
        };
      }
      let heapProfile: BenchmarkRun["heapProfile"];
      if (heapProfilePath) {
        await controlGatewayProfile(gateway, "heap", "stop", heapProfilePath);
        heapProfile = {
          ...readGatewayHeapProfile(heapProfilePath),
          scope: "main-isolate",
          workersManifestPath: `${heapProfilePath}.workers.json`,
        };
      }
      if (options.historyClients > 0 && !history.some((sample) => sample.ok)) {
        const failure = history[0]?.error ?? "no requests completed before turns finished";
        throw new Error(`all configured chat.history load probes failed: ${failure}`);
      }
      peakRssMb = Math.max(peakRssMb, memoryAfter.rssMb);
      mockCheckpoints.push(await readMockRequests(mockPort, loadDeadlineAt));

      if (agentCoverage) {
        agentCoverage.completedTurns = agentIds.map((agentId) => ({
          agentId,
          count: sessionTurnCounts.reduce(
            (total, count, index) => total + (turnAgentIds[index] === agentId ? count : 0),
            0,
          ),
        }));
      }
      result = {
        ...(agentCoverage ? { agentCoverage } : {}),
        ...(browserProbe && browserInventory
          ? {
              browser: {
                newPageReadyMs: browserProbe.newPageReadyMs,
                initialSessionReadyMs: browserProbe.initialSessionReadyMs,
                historyMessagesPerTarget: browserHistoryMessages,
                inventory: browserInventory,
                clicks: browserClickResults,
              },
            }
          : {}),
        ...(heapProfile ? { heapProfile } : {}),
        ...(loadCpuProfile ? { loadCpuProfile } : {}),
        controlPlane,
        controlUi,
        cpuUsage: measureGatewayCpuUsage(cpuBefore, cpuAfter),
        processPlacement,
        durationMs: performance.now() - runStartedAt,
        freshConnection: freshConnectionResult,
        history,
        loadWindow: {
          startMonotonicMicros: loadStartMonotonicMicros,
          endMonotonicMicros: loadEndMonotonicMicros,
        },
        memory: { after: memoryAfter, before: memoryBefore, peakRssMb },
        messageSubscriptions,
        messageSubscriptionsDuringLoad,
        turnAccounting,
        probeWarmup,
        pluginMetadataScans: summarizePluginMetadataScans([]),
        readyz,
        sessionSeedDurationMs,
        sessionsList,
        sessionUpdates,
        setupDurationMs,
        turnCount: sessionTurnCounts.reduce((sum, count) => sum + count, 0),
        turnsDurationMs,
      };
    } catch (error) {
      const detail = formatRunFailure(error, gatewayOutput, mockOutput);
      console.error(
        `turn accounting at failure: ${JSON.stringify({ requested: options.concurrency * options.turnsPerSession, ...turnAccounting, agentWarmup })}`,
      );
      try {
        const requests = readProviderRequestLog(requestLogPath);
        console.error(
          `provider requests at failure: ${JSON.stringify(summarizeProviderRequests(requests, providerBeforeLoad ?? requests.length, providerAfterLoad ?? requests.length, agentWarmup))}`,
        );
      } catch (accountingError) {
        console.error(`provider request accounting failed: ${String(accountingError)}`);
      }
      throw new Error(detail, { cause: error });
    } finally {
      probesStopped = true;
      try {
        await browserProbe?.close();
      } finally {
        for (const auxiliaryClient of auxiliaryClients) {
          auxiliaryClient.close();
        }
        try {
          if (gateway) {
            if (options.cpuProfDir && gateway.exitCode === null && gateway.signalCode === null) {
              // V8 flushes the main-isolate CPU profile on its normal interrupt path.
              const profileFlushed = new Promise<void>((resolve) => {
                gateway!.once("exit", () => {
                  resolve();
                });
              });
              gateway.kill("SIGINT");
              await Promise.race([profileFlushed, delay(2_000)]);
            }
            gatewayExit = await stopChild(gateway);
          }
          // A fatal turn may end Promise.all before fixed probe rounds settle.
          // Join their closed-client failures before removing the fixture state.
          await Promise.allSettled(probeJobs);
        } finally {
          // Gateway shutdown drains admitted event dispatches before closing sockets.
          // Keep this client alive through that drain so delayed tool evidence survives.
          client?.close();
        }
      }
    }
    // close() initiates a handshake; retain late event evidence until it settles.
    await client?.waitClosed();
    mockCheckpoints.push(await readMockRequests(mockPort, performance.now() + HTTP_TIMEOUT_MS));
    if (options.diagnosticsTimeline) {
      if (!gatewayExit || gatewayExit.exitCode !== 0 || gatewayExit.signal !== null) {
        throw new Error(
          formatRunFailure(
            new Error(
              `Gateway did not exit cleanly; diagnostics timeline may be incomplete: ${JSON.stringify({ helper: gatewayExit, child: readGatewayProcess() })}`,
            ),
            gatewayOutput,
            mockOutput,
          ),
        );
      }
      if (gatewayOutput.readOutput().includes("[diagnostics] failed to write timeline event")) {
        throw new Error("Gateway reported a diagnostics timeline write failure");
      }
      result.pluginMetadataScans = summarizePluginMetadataScans(
        readDiagnosticsTimelineSpans(timelinePath, timelineWindow),
      );
    }
    if (providerBeforeLoad === undefined || providerAfterLoad === undefined) {
      throw new Error("Missing provider request load snapshots");
    }
    return {
      ...result,
      providerRequests: summarizeProviderRequests(
        readProviderRequestLog(requestLogPath),
        providerBeforeLoad,
        providerAfterLoad,
        agentWarmup,
      ),
      mockRequests: summarizeMockRequests(mockCheckpoints),
      turnEvidence: turnEvidence.finish(),
      agentWarmup: { ...agentWarmup, turnEvidence: turnEvidence.finish("warmup") },
      gatewayProcess: readGatewayProcess(),
      ...(gatewayExit ? { gatewayExit } : {}),
    };
  } finally {
    try {
      if (mockProvider) {
        await stopChild(mockProvider);
      }
    } finally {
      rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
    }
  }
}

function summarizeRuns(
  runs: readonly BenchmarkRun[],
  options: Pick<CliOptions, "maxControlMs" | "maxHandshakeMs"> = {},
) {
  const controlPlane = runs.flatMap((run) => run.controlPlane);
  const browserClicks = runs.flatMap((run) => run.browser?.clicks ?? []);
  const controlUi = runs.flatMap((run) => run.controlUi);
  const readyz = runs.flatMap((run) => run.readyz);
  const sessionsList = runs.flatMap((run) => run.sessionsList);
  const history = runs.flatMap((run) => run.history);
  const subscriptions = runs.flatMap((run) => run.messageSubscriptions);
  const subscriptionsDuringLoad = runs.flatMap((run) => run.messageSubscriptionsDuringLoad);
  const sessionUpdates = runs.flatMap((run) => run.sessionUpdates);
  // Setup subscriptions and warmup probes are not load-phase measurements.
  const controlMethods = ["tasks.list", "cron.list", "cron.status"];
  const controlMethodProbes = controlMethods.map((method) => ({
    method,
    samples: controlPlane.filter((sample) => sample.method === method),
  }));
  const budgetViolations = [
    ...controlMethodProbes.map(({ method, samples }) => ({
      name: `Gateway ${method} probe`,
      maxMs: options.maxControlMs,
      samples,
    })),
    {
      name: "fresh Gateway connection",
      maxMs: options.maxHandshakeMs,
      samples: runs.map((run) => run.freshConnection),
    },
    ...(
      [
        ["readyz", readyz],
        ["Control UI", controlUi],
        ["sessions.list", sessionsList],
        ["chat.history", history],
        ["sessions.messages.subscribe", subscriptionsDuringLoad],
        ["sessions.patch", sessionUpdates],
      ] as const
    ).map(([name, samples]) => ({
      name: `Gateway ${name} probe`,
      maxMs: options.maxControlMs,
      samples,
    })),
  ].flatMap(({ name, maxMs, samples }) => {
    if (maxMs === undefined) {
      return [];
    }
    const violation = samples.find((sample) => !sample.ok || sample.latencyMs > maxMs);
    return violation
      ? [
          `${name} exceeded ${maxMs}ms: ok=${violation.ok} ` +
            `latencyMs=${violation.latencyMs.toFixed(1)} error=${violation.error ?? "none"}`,
        ]
      : [];
  });
  for (const sample of browserClicks) {
    if (sample.error) {
      budgetViolations.push(`Browser session ${sample.sessionKey} failed: ${sample.error}`);
    }
  }
  return {
    ...(browserClicks.length > 0
      ? {
          browserSessionClicks: {
            failedSamples: browserClicks.filter((sample) => sample.error !== null).length,
            samplesOutsideActiveLoad: browserClicks.filter(
              (sample) => !sample.activeLoadAtStart || !sample.activeLoadAtFinish,
            ).length,
            firstVisitReadyMs: summarizeNumbers(
              browserClicks.flatMap((sample) =>
                !sample.revisit && sample.readyMs !== null ? [sample.readyMs] : [],
              ),
            ),
            revisitReadyMs: summarizeNumbers(
              browserClicks.flatMap((sample) =>
                sample.revisit && sample.readyMs !== null ? [sample.readyMs] : [],
              ),
            ),
          },
        }
      : {}),
    budgetViolations,
    gatewayProcessCpuMs: summarizeNumbers(runs.map((run) => run.cpuUsage.process.totalMs)),
    gatewayProcessCpuMsPerTurn: summarizeNumbers(
      runs.map((run) => run.cpuUsage.process.totalMs / run.turnCount),
    ),
    gatewayMainThreadCpuMs: summarizeNumbers(runs.map((run) => run.cpuUsage.mainThread.totalMs)),
    gatewayProcessCpuCoreRatio: summarizeNumbers(
      runs.map((run) => run.cpuUsage.process.totalMs / run.cpuUsage.wallMs),
    ),
    gatewaySampledAllocatedBytes: summarizeNumbers(
      runs.flatMap((run) => (run.heapProfile ? [run.heapProfile.sampledAllocatedBytes] : [])),
    ),
    gatewaySampledAllocatedBytesPerTurn: summarizeNumbers(
      runs.flatMap((run) =>
        run.heapProfile ? [run.heapProfile.sampledAllocatedBytes / run.turnCount] : [],
      ),
    ),
    controlPlane: Object.fromEntries(
      controlMethodProbes.map(({ method, samples }) => [
        method,
        {
          failedSamples: samples.filter((sample) => !sample.ok).length,
          latencyMs: summarizeNumbers(samples.map((sample) => sample.latencyMs)),
        },
      ]),
    ),
    controlUiFailedSamples: controlUi.filter((sample) => !sample.ok).length,
    controlUiLatencyMs: summarizeNumbers(controlUi.map((sample) => sample.latencyMs)),
    cpuCoreRatio: summarizeNumbers(
      readyz.flatMap((sample) => (sample.cpuCoreRatio == null ? [] : [sample.cpuCoreRatio])),
    ),
    degradedSamples: readyz.filter((sample) => sample.degraded === true).length,
    eventLoopDelayMaxMs: summarizeNumbers(
      readyz.flatMap((sample) => (sample.delayMaxMs == null ? [] : [sample.delayMaxMs])),
    ),
    eventLoopDelayP99Ms: summarizeNumbers(
      readyz.flatMap((sample) => (sample.delayP99Ms == null ? [] : [sample.delayP99Ms])),
    ),
    eventLoopUtilization: summarizeNumbers(
      readyz.flatMap((sample) => (sample.utilization == null ? [] : [sample.utilization])),
    ),
    freshConnectionFailedRuns: runs.filter((run) => !run.freshConnection.ok).length,
    freshConnectionLatencyMs: summarizeNumbers(runs.map((run) => run.freshConnection.latencyMs)),
    gatewayUncleanExits: runs.filter(
      (run) =>
        run.gatewayExit && (run.gatewayExit.exitCode !== 0 || run.gatewayExit.signal !== null),
    ).length,
    gatewayExternalGrowthMb: summarizeNumbers(
      runs.flatMap((run) => {
        const before = run.memory.before.externalMb;
        const after = run.memory.after.externalMb;
        return before === undefined || after === undefined ? [] : [after - before];
      }),
    ),
    gatewayExternalMb: summarizeNumbers(
      runs.flatMap((run) =>
        run.memory.after.externalMb === undefined ? [] : [run.memory.after.externalMb],
      ),
    ),
    gatewayArrayBuffersGrowthMb: summarizeNumbers(
      runs.flatMap((run) => {
        const before = run.memory.before.arrayBuffersMb;
        const after = run.memory.after.arrayBuffersMb;
        return before === undefined || after === undefined ? [] : [after - before];
      }),
    ),
    gatewayArrayBuffersMb: summarizeNumbers(
      runs.flatMap((run) =>
        run.memory.after.arrayBuffersMb === undefined ? [] : [run.memory.after.arrayBuffersMb],
      ),
    ),
    gatewayHeapGrowthMb: summarizeNumbers(
      runs.map((run) => run.memory.after.heapUsedMb - run.memory.before.heapUsedMb),
    ),
    gatewayHeapUsedMb: summarizeNumbers(runs.map((run) => run.memory.after.heapUsedMb)),
    gatewayPeakRssMb: summarizeNumbers(runs.map((run) => run.memory.peakRssMb)),
    gatewayRssGrowthMb: summarizeNumbers(
      runs.map((run) => run.memory.after.rssMb - run.memory.before.rssMb),
    ),
    historyFailedSamples: history.filter((sample) => !sample.ok).length,
    historyLatencyMs: summarizeNumbers(history.map((sample) => sample.latencyMs)),
    historySampleCount: history.length,
    messageSubscriptionFailedSamples: subscriptions.filter((sample) => !sample.ok).length,
    messageSubscriptionLatencyMs: summarizeNumbers(subscriptions.map((sample) => sample.latencyMs)),
    messageSubscriptionLoadFailedSamples: subscriptionsDuringLoad.filter((sample) => !sample.ok)
      .length,
    messageSubscriptionLoadLatencyMs: summarizeNumbers(
      subscriptionsDuringLoad.map((sample) => sample.latencyMs),
    ),
    mockRequestIngress: Object.fromEntries(
      MOCK_INGRESS_KEYS.map((key) => [
        key,
        runs.reduce((count, run) => count + run.mockRequests.ingress.total[key], 0),
      ]),
    ),
    mockResponseSelections: Object.fromEntries(
      MOCK_SELECTION_KEYS.map((key) => [
        key,
        runs.reduce((count, run) => count + run.mockRequests.selections[key], 0),
      ]),
    ),
    toolTurns: runs.reduce((count, run) => count + run.turnEvidence.toolTurns, 0),
    observerModelDigestTurns: runs.reduce(
      (count, run) => count + run.turnEvidence.observerModelDigestTurns,
      0,
    ),
    pluginMetadataScanCount: runs.reduce((sum, run) => sum + run.pluginMetadataScans.count, 0),
    pluginMetadataScanTotalDurationMs: runs.reduce(
      (sum, run) => sum + run.pluginMetadataScans.totalDurationMs,
      0,
    ),
    readyzLatencyMs: summarizeNumbers(readyz.map((sample) => sample.latencyMs)),
    readyzFailedSamples: readyz.filter((sample) => !sample.ok).length,
    sampleCount: readyz.length,
    sessionSeedDurationMs: summarizeNumbers(runs.map((run) => run.sessionSeedDurationMs)),
    sessionsListLatencyMs: summarizeNumbers(sessionsList.map((sample) => sample.latencyMs)),
    sessionsListFailedSamples: sessionsList.filter((sample) => !sample.ok).length,
    sessionUpdateFailedSamples: sessionUpdates.filter((sample) => !sample.ok).length,
    sessionUpdateLatencyMs: summarizeNumbers(sessionUpdates.map((sample) => sample.latencyMs)),
    sessionUpdateSampleCount: sessionUpdates.length,
    setupDurationMs: summarizeNumbers(runs.map((run) => run.setupDurationMs)),
    turnCount: runs.reduce((sum, run) => sum + run.turnCount, 0),
    turnsDurationMs: summarizeNumbers(runs.map((run) => run.turnsDurationMs)),
  };
}

async function runBenchmarkSamples(params: {
  now?: () => number;
  onProgress?: (message: string) => void;
  options: CliOptions;
  runSample?: typeof runGatewaySample;
}): Promise<BenchmarkRun[]> {
  const now = params.now ?? performance.now.bind(performance);
  const runSample = params.runSample ?? runGatewaySample;
  const runs: BenchmarkRun[] = [];
  const total = params.options.runs + params.options.warmup;
  for (let index = 0; index < total; index += 1) {
    // Each sample gets the same budget so earlier runs cannot shrink later agent waits.
    // runGatewaySample extends this deadline by its probe warmup before load starts.
    const deadlineAt = now() + params.options.timeoutMs;
    const run = await runSample({ ...params.options, deadlineAt });
    if (index >= params.options.warmup) {
      runs.push(run);
      params.onProgress?.(
        `[bench-gateway-concurrency] run ${runs.length}/${params.options.runs}: turns=${run.turnCount} samples=${run.readyz.length} duration=${run.durationMs.toFixed(1)}ms`,
      );
    } else {
      params.onProgress?.(
        `[bench-gateway-concurrency] warmup ${index + 1}/${params.options.warmup}: duration=${run.durationMs.toFixed(1)}ms`,
      );
    }
  }
  return runs;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    printUsage();
    return;
  }
  const options = parseOptions(argv);
  const runs = await runBenchmarkSamples({ onProgress: console.error, options });
  const payload = {
    agentCount: options.agentCount,
    browserHistoryMessages: options.browserHistoryMessages,
    browserSessionClicks: options.browserSessionClicks,
    cadenceMs: options.cadenceMs,
    concurrency: options.concurrency,
    controlPlane: options.controlPlane,
    historyMessages: options.historyMessages,
    historyMessageChars: options.historyMessageChars,
    diagnosticsTimeline: options.diagnosticsTimeline,
    entry: options.entry,
    generatedAt: new Date().toISOString(),
    historyBurst: options.historyBurst,
    historyClients: options.historyClients,
    mode: "mock-streaming-agent",
    pluginCount: options.pluginCount,
    probeWorkload: {
      mode: options.probeRounds === undefined ? "adaptive" : "fixed-rounds",
      samplerRoundsPerRun: options.probeRounds ?? null,
      historyRequestsPerRun:
        options.probeRounds === undefined
          ? null
          : options.probeRounds * options.historyClients * options.historyBurst,
      peakRssSampling: "sampler-rounds-and-final-memory",
    },
    runs,
    sessionCount: Math.max(options.sessionCount, options.concurrency),
    sessionUpdateClients: options.sessionUpdates > 0 ? options.sessionUpdateClients : 0,
    sessionUpdates: options.sessionUpdates,
    streamChunkDelayMs: options.streamChunkDelayMs,
    effectivePacing: options.toolEvents
      ? { kind: "shell-delay", toolDelayMs: 3000, streamChunkDelayMs: 0 }
      : { kind: "text-stream", streamChunkDelayMs: options.streamChunkDelayMs },
    subscribers: options.subscribers,
    summary: summarizeRuns(runs, options),
    toolEvents: options.toolEvents,
    turnsPerSession: options.turnsPerSession,
    agentWarmupTurns: options.agentWarmupTurns,
    gatewayCpus: options.gatewayCpus,
    visibleObserver: options.visibleObserver,
    workspaceFanout: options.workspaceFanout,
  };
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  }
  if (options.json || !options.output) {
    console.log(JSON.stringify(payload, null, 2));
  }
  if (payload.summary.budgetViolations.length > 0) {
    throw new Error(payload.summary.budgetViolations.join("\n"));
  }
}

export const testing = {
  parseOptions,
  parseMockRequests,
  summarizeMockRequests,
  createTurnEvidence,
  formatProbeFailure,
  formatRunFailure,
  requestHttp,
  runBenchmarkSamples,
  runProbeRounds,
  runSessionTurns,
  runTurn,
  sampleGateway,
  readDiagnosticsTimelineSpans,
  summarizePluginMetadataScans,
  summarizeNumbers,
  summarizeRuns,
  summarizeProviderRequests,
  tailLines,
  warmGatewayProbes,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main()
    .catch((error: unknown) => {
      console.error(error instanceof CliArgumentError ? error.message : (error as Error)?.stack);
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.exitCode && process.exitCode !== 0) {
        console.error(`[bench-gateway-concurrency] FAILED (exit ${process.exitCode})`);
      }
    });
}
