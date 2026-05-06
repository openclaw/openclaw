import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { DEFAULT_SOURCE_ROOT, seedRealSessions } from "./bench-sessions-list-seed.js";

type BenchOptions = {
  activeMinutes?: number;
  agentCount?: number;
  agentId?: string;
  coldRuns: number;
  includeGlobal: boolean;
  includeDerivedTitles: boolean;
  includeLastMessage: boolean;
  includeUnknown: boolean;
  inflateTranscriptKiB: number;
  json: boolean;
  keepTemp: boolean;
  limit?: number;
  output?: string;
  recentSessions?: number;
  recentWindowMinutes: number;
  runs: number;
  sessions: number;
  sourceRoot: string;
  sourceStore?: string;
  targetWrittenMiB: number;
  warmup: number;
};

type Sample = {
  elapsedMs: number;
  eventLoopDelayMaxMs: number;
  rows: number;
};

type SessionsHandlers = typeof import("../src/gateway/server-methods/sessions.js").sessionsHandlers;

const DEFAULT_SESSIONS = 1000;
const DEFAULT_COLD_RUNS = 3;
const DEFAULT_RUNS = 5;
const DEFAULT_WARMUP = 1;

function flagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function positiveInt(flag: string, defaultValue: number): number {
  const raw = flagValue(flag);
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function optionalPositiveInt(flag: string): number | undefined {
  const raw = flagValue(flag);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInt(flag: string, defaultValue: number): number {
  const raw = flagValue(flag);
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function optionalNonNegativeInt(flag: string): number | undefined {
  const raw = flagValue(flag);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptions(): BenchOptions {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage();
    process.exit(0);
  }
  const sourceStore = flagValue("--source-store");
  const agentId = flagValue("--agent-id")?.trim();
  return {
    activeMinutes: optionalPositiveInt("--active-minutes"),
    agentCount: optionalPositiveInt("--agent-count"),
    agentId: agentId || undefined,
    coldRuns: nonNegativeInt("--cold-runs", DEFAULT_COLD_RUNS),
    includeGlobal: !hasFlag("--exclude-global"),
    includeDerivedTitles: hasFlag("--include-derived-titles"),
    includeLastMessage: hasFlag("--include-last-message"),
    includeUnknown: !hasFlag("--exclude-unknown"),
    inflateTranscriptKiB: nonNegativeInt("--inflate-transcript-kib", 0),
    json: hasFlag("--json"),
    keepTemp: hasFlag("--keep-temp"),
    limit: optionalPositiveInt("--limit"),
    output: flagValue("--output"),
    recentSessions: optionalNonNegativeInt("--recent-sessions"),
    recentWindowMinutes: positiveInt("--recent-window-minutes", 1440),
    runs: positiveInt("--runs", DEFAULT_RUNS),
    sessions: positiveInt("--sessions", DEFAULT_SESSIONS),
    sourceRoot: path.resolve(flagValue("--source-root") ?? DEFAULT_SOURCE_ROOT),
    sourceStore: sourceStore ? path.resolve(sourceStore) : undefined,
    targetWrittenMiB: nonNegativeInt("--target-written-mib", 0),
    warmup: nonNegativeInt("--warmup", DEFAULT_WARMUP),
  };
}

function printUsage(): void {
  console.log(`OpenClaw sessions.list benchmark

Usage:
  pnpm test:sessions:list:bench -- [options]
  node --import tsx scripts/bench-sessions-list.ts [options]

Options:
  --sessions <count>           Seeded session count (default: ${DEFAULT_SESSIONS})
  --agent-count <count>        Seed across this many agent dirs
  --source-root <path>         agents directory to clone (default: ${DEFAULT_SOURCE_ROOT})
  --source-store <path>        single sessions.json to clone instead of all agents
  --inflate-transcript-kib <n> Repeat real transcript bytes until each clone is at least n KiB
  --target-written-mib <n>     Inflate transcripts to write at least this many MiB total
  --recent-sessions <count>    Keep only this many sessions inside the recent window
  --recent-window-minutes <n>  Recent window used while seeding timestamps (default: 1440)
  --limit <count>              Pass sessions.list limit
  --active-minutes <count>     Pass sessions.list activeMinutes
  --agent-id <id>              Pass sessions.list agentId
  --cold-runs <count>          Fresh cloned profile runs (default: ${DEFAULT_COLD_RUNS})
  --runs <count>               Measured runs (default: ${DEFAULT_RUNS})
  --warmup <count>             Warmup runs (default: ${DEFAULT_WARMUP})
  --include-derived-titles     Request derived titles
  --include-last-message       Request last-message previews
  --exclude-global             Do not request global rows
  --exclude-unknown            Do not request unknown rows
  --keep-temp                  Keep cloned temp profiles on disk
  --json                       Print JSON
  --output <path>              Write JSON report
`);
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function summarize(samples: Sample[]) {
  const elapsed = samples.map((sample) => sample.elapsedMs);
  return {
    minMs: Math.min(...elapsed),
    p50Ms: percentile(elapsed, 50),
    p95Ms: percentile(elapsed, 95),
    maxMs: Math.max(...elapsed),
    avgMs: elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length,
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

async function callSessionsList(params: {
  activeMinutes?: number;
  agentId?: string;
  config: OpenClawConfig;
  includeGlobal: boolean;
  includeDerivedTitles: boolean;
  includeLastMessage: boolean;
  includeUnknown: boolean;
  limit?: number;
  sessionsHandlers: SessionsHandlers;
}): Promise<SessionsListResult> {
  let payload: SessionsListResult | undefined;
  let error: unknown;
  const listParams = {
    includeGlobal: params.includeGlobal,
    includeUnknown: params.includeUnknown,
    includeDerivedTitles: params.includeDerivedTitles,
    includeLastMessage: params.includeLastMessage,
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.activeMinutes !== undefined ? { activeMinutes: params.activeMinutes } : {}),
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
  };
  await params.sessionsHandlers["sessions.list"]({
    req: {
      type: "req",
      id: "bench-sessions-list",
      method: "sessions.list",
      params: listParams,
    },
    params: listParams,
    respond: (ok, response, responseError) => {
      if (!ok) {
        error = responseError;
        return;
      }
      payload = response as SessionsListResult;
    },
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => params.config,
      loadGatewayModelCatalog: async () => [],
      logGateway: { debug: () => {} },
      chatAbortControllers: new Map(),
    } as never,
  });
  if (!payload) {
    throw new Error(`sessions.list failed: ${JSON.stringify(error)}`);
  }
  return payload;
}

async function measure(params: {
  activeMinutes?: number;
  agentId?: string;
  config: OpenClawConfig;
  includeGlobal: boolean;
  includeDerivedTitles: boolean;
  includeLastMessage: boolean;
  includeUnknown: boolean;
  limit?: number;
  sessionsHandlers: SessionsHandlers;
}): Promise<Sample> {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const start = performance.now();
  const result = await callSessionsList(params);
  const elapsedMs = performance.now() - start;
  delay.disable();
  return {
    elapsedMs,
    eventLoopDelayMaxMs: delay.max / 1_000_000,
    rows: result.sessions.length,
  };
}

const options = parseOptions();
const { sessionsHandlers } = await import("../src/gateway/server-methods/sessions.js");
const tempRoots: string[] = [];

const coldSamples: Sample[] = [];
for (let index = 0; index < options.coldRuns; index += 1) {
  const coldSeeded = seedRealSessions(options);
  tempRoots.push(coldSeeded.root);
  process.env.OPENCLAW_STATE_DIR = coldSeeded.root;
  const sample = await measure({
    config: coldSeeded.config,
    activeMinutes: options.activeMinutes,
    agentId: options.agentId,
    includeGlobal: options.includeGlobal,
    includeDerivedTitles: options.includeDerivedTitles,
    includeLastMessage: options.includeLastMessage,
    includeUnknown: options.includeUnknown,
    limit: options.limit,
    sessionsHandlers,
  });
  coldSamples.push(sample);
  if (!options.json) {
    console.log(
      `[sessions-list-bench] cold ${index + 1}/${options.coldRuns}: rows=${sample.rows} wall=${formatMs(sample.elapsedMs)} eventLoopDelayMax=${formatMs(sample.eventLoopDelayMaxMs)}`,
    );
  }
}

const seeded = seedRealSessions(options);
tempRoots.push(seeded.root);
process.env.OPENCLAW_STATE_DIR = seeded.root;

if (!options.json) {
  console.log(
    `[sessions-list-bench] cloned ${options.sessions} sessions across ${seeded.seed.targetAgents} agents from ${seeded.seed.sourceTranscripts}/${seeded.seed.sourceRows} transcript-backed source rows across ${seeded.seed.sourceStores} stores (${Math.round(seeded.seed.writtenBytes / 1024 / 1024)} MiB written)`,
  );
}

const warmups: Sample[] = [];
for (let index = 0; index < options.warmup; index += 1) {
  const sample = await measure({
    config: seeded.config,
    activeMinutes: options.activeMinutes,
    agentId: options.agentId,
    includeGlobal: options.includeGlobal,
    includeDerivedTitles: options.includeDerivedTitles,
    includeLastMessage: options.includeLastMessage,
    includeUnknown: options.includeUnknown,
    limit: options.limit,
    sessionsHandlers,
  });
  warmups.push(sample);
  if (!options.json) {
    console.log(
      `[sessions-list-bench] warmup ${index + 1}/${options.warmup}: rows=${sample.rows} wall=${formatMs(sample.elapsedMs)} eventLoopDelayMax=${formatMs(sample.eventLoopDelayMaxMs)}`,
    );
  }
}

const samples: Sample[] = [];
for (let index = 0; index < options.runs; index += 1) {
  const sample = await measure({
    config: seeded.config,
    activeMinutes: options.activeMinutes,
    agentId: options.agentId,
    includeGlobal: options.includeGlobal,
    includeDerivedTitles: options.includeDerivedTitles,
    includeLastMessage: options.includeLastMessage,
    includeUnknown: options.includeUnknown,
    limit: options.limit,
    sessionsHandlers,
  });
  samples.push(sample);
  if (!options.json) {
    console.log(
      `[sessions-list-bench] run ${index + 1}/${options.runs}: rows=${sample.rows} wall=${formatMs(sample.elapsedMs)} eventLoopDelayMax=${formatMs(sample.eventLoopDelayMaxMs)}`,
    );
  }
}

const report = {
  options,
  seed: seeded.seed,
  storePath: seeded.storePath,
  coldSamples,
  coldSummary: coldSamples.length > 0 ? summarize(coldSamples) : null,
  warmups,
  samples,
  summary: summarize(samples),
};

if (options.output) {
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const summary = report.summary;
  const coldSummary = report.coldSummary;
  if (coldSummary) {
    console.log(
      `[sessions-list-bench] cold summary: sessions=${options.sessions} min=${formatMs(coldSummary.minMs)} p50=${formatMs(coldSummary.p50Ms)} p95=${formatMs(coldSummary.p95Ms)} max=${formatMs(coldSummary.maxMs)} avg=${formatMs(coldSummary.avgMs)}`,
    );
  }
  console.log(
    `[sessions-list-bench] summary: sessions=${options.sessions} rows=${samples.at(-1)?.rows ?? 0} min=${formatMs(summary.minMs)} p50=${formatMs(summary.p50Ms)} p95=${formatMs(summary.p95Ms)} max=${formatMs(summary.maxMs)} avg=${formatMs(summary.avgMs)}`,
  );
  if (options.output) {
    console.log(`[sessions-list-bench] wrote ${options.output}`);
  }
}

if (!options.keepTemp) {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
