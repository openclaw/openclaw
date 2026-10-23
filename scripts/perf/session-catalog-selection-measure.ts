// Run only on an approved benchmark host with synthetic state and --expose-gc --trace-gc-nvp.
import assert from "node:assert/strict";
import { createHash, hash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, writeSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SessionCatalog } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayRequestContext } from "../../src/gateway/server-methods/types.js";
import type { SessionCatalogProvider } from "../../src/plugins/session-catalog.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    operations: { type: "string", default: "4000" },
    "yield-ms": { type: "string", default: "1" },
    "start-at": { type: "string", default: "0" },
    "gc-log": { type: "string" },
    output: { type: "string" },
    allocations: { type: "boolean", default: false },
    unchanged: { type: "boolean", default: false },
  },
});
const integer = (name: "operations" | "yield-ms" | "start-at", min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const operations = integer("operations", 1);
const yieldMs = integer("yield-ms", 0);
const startAt = integer("start-at", 0);
assert.ok(global.gc, "Run with --expose-gc");
const stateDir = values["state-dir"]
  ? path.resolve(values["state-dir"])
  : mkdtempSync(path.join(os.tmpdir(), "catalog-selection-"));
if (values["state-dir"]) {
  mkdirSync(stateDir, { mode: 0o700 });
}
for (const directory of ["home", "tmp"]) {
  mkdirSync(path.join(stateDir, directory));
}
const configPath = path.join(stateDir, "openclaw.json");
const cfg: OpenClawConfig = {
  agents: { ownership: "explicit", entries: { main: {}, work: {} } },
  plugins: { enabled: false },
};
writeFileSync(configPath, JSON.stringify(cfg));
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};
const profilePath = path.join(stateDir, "allocation.heapprofile");
const marker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
// Identify the main isolate before imports can start database workers.
marker("identify-start");
global.gc();
marker("identify-stop");

const [
  { setRuntimeConfigSnapshot },
  { replaceSessionEntrySync },
  { writeSessionEntry },
  { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync },
  { closeOpenClawStateDatabaseAsync },
  { createSessionRowProjection },
  { bindSessionRowProjection },
  { sessionCatalogHandlers },
  { retireSessionCatalogLists },
  { createEmptyPluginRegistry },
  { setActivePluginRegistry },
  { createSubsystemLogger },
] = await Promise.all([
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/config/sessions/session-accessor.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/gateway/session-row-projection.js"),
  import("../../src/gateway/session-row-projection-access.js"),
  import("../../src/gateway/server-methods/session-catalog.js"),
  import("../../src/gateway/server-methods/session-catalog-list-operations.js"),
  import("../../src/plugins/registry-empty.js"),
  import("../../src/plugins/runtime.js"),
  import("../../src/logging/subsystem.js"),
]);

const agents = ["main", "work"] as const;
const sessionsPerAgent = 2500;
const sessionCount = agents.length * sessionsPerAgent;
const keyFor = (agentId: string, index: number) =>
  `agent:${agentId}:catalog-${String(index).padStart(4, "0")}`;
const entryFor = (agentId: string, index: number, revision = 0): SessionEntry => ({
  sessionId: `catalog-${agentId}-${index}`,
  updatedAt: 1_700_000_000_000 + index + revision * sessionCount,
  label: `Synthetic ${agentId} session ${index}, revision ${revision}`,
  ...(index % 5 === 0 ? { archivedAt: 1_700_000_000_000 + index } : {}),
});
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count,
    totalMs,
    meanMs: count ? totalMs / count : 0,
    maxMs: sorted.at(-1) ?? 0,
    p50: { samples: count, ms: sorted[Math.ceil(count * 0.5) - 1] ?? null },
    p95: { samples: count, ms: sorted[Math.ceil(count * 0.95) - 1] ?? null },
    p99: { samples: count, ms: sorted[Math.ceil(count * 0.99) - 1] ?? null },
  };
}
function allocation(profile: HeapProfiler.SamplingHeapProfile) {
  let totalBytes = 0;
  let selectionBytes = 0;
  let catalogBytes = 0;
  const visit = (
    node: HeapProfiler.SamplingHeapProfileNode,
    inSelection = false,
    inCatalog = false,
  ) => {
    const selection =
      inSelection ||
      node.callFrame.url.includes("session-row-selection") ||
      node.callFrame.functionName === "prepareSessionRowSelection";
    const catalog =
      inCatalog || node.callFrame.url.includes("/src/gateway/server-methods/session-catalog");
    totalBytes += node.selfSize;
    selectionBytes += selection ? node.selfSize : 0;
    catalogBytes += catalog ? node.selfSize : 0;
    node.children.forEach((child) => visit(child, selection, catalog));
  };
  visit(profile.head);
  return {
    totalBytes,
    bytesPerOperation: totalBytes / operations,
    selectionBytes,
    selectionBytesPerOperation: selectionBytes / operations,
    catalogBytes,
    catalogBytesPerOperation: catalogBytes / operations,
  };
}

let providerCalls = 0;
let providerRows = 0;
let providerRevisions = 0;
let captureGolden = false;
const lastRevisions = new Map<string, object | undefined>();
const entryGoldens = new Map<string, string>();
const registry = createEmptyPluginRegistry();
for (const agentId of agents) {
  const provider: SessionCatalogProvider = {
    id: `synthetic-${agentId}`,
    label: `Synthetic ${agentId}`,
    list: async ({ sessionEntries, limitPerHost }) => {
      assert.ok(sessionEntries?.entriesForCatalog, "Handler must supply the planning snapshot");
      const all = sessionEntries.entriesForCatalog();
      const entries = sessionEntries.entriesForAgent(agentId);
      assert.equal(all.length, sessionCount);
      assert.equal(entries.length, sessionsPerAgent);
      assert.equal(sessionEntries.entriesForAgent(agentId), entries);
      providerCalls++;
      providerRows += entries.length;
      if (lastRevisions.get(agentId) !== sessionEntries.revision) {
        providerRevisions++;
        lastRevisions.set(agentId, sessionEntries.revision);
      }
      if (captureGolden) {
        entryGoldens.set(agentId, hash("sha256", JSON.stringify(entries), "hex"));
      }
      return [
        {
          hostId: `synthetic:${agentId}`,
          label: `Synthetic ${agentId}`,
          kind: "gateway",
          connected: true,
          sessions: entries.slice(0, limitPerHost).map(({ sessionKey, entry }) => ({
            threadId: entry.sessionId,
            sessionKey,
            name: entry.label,
            updatedAt: entry.updatedAt,
            status: "stored",
            archived: entry.archivedAt !== undefined,
            canContinue: true,
            canArchive: false,
          })),
        },
      ];
    },
    read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
  };
  registry.sessionCatalogs.push({ pluginId: provider.id, source: "synthetic", provider });
}
setActivePluginRegistry(registry);
setRuntimeConfigSnapshot(cfg, cfg);
let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
const inspector = new Session();
let inspectorConnected = false;
const collections: { kind: number; ms: number }[] = [];
let measuredStart = Infinity;
let measuredEnd = Infinity;
function recordGc(entries: PerformanceEntry[]) {
  for (const entry of entries) {
    if (entry.startTime >= measuredStart && entry.startTime < measuredEnd) {
      collections.push({
        kind: (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind,
        ms: entry.duration,
      });
    }
  }
}
const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
const loop = monitorEventLoopDelay({ resolution: 1 });
try {
  // Two small sequential transactions; no transcripts or copied databases.
  for (const agentId of agents) {
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < sessionsPerAgent; index++) {
          writeSessionEntry(database, keyFor(agentId, index), entryFor(agentId, index));
        }
      },
      { agentId },
    );
  }
  projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  // Finish cold-row hydration before capturing resident order or measuring warm metadata updates.
  await projection.prepareSelection();
  await projection.ensureMaterialized();
  // This fixture supplies only the context fields consumed by sessions.catalog.list.
  const context = bindSessionRowProjection(
    {
      getRuntimeConfig: () => cfg,
      logGateway: createSubsystemLogger("benchmark/catalog"),
    },
    () => projection,
  ) as GatewayRequestContext;
  const handler = sessionCatalogHandlers["sessions.catalog.list"]!;
  async function list() {
    let result: unknown;
    let replies = 0;
    await handler({
      req: { type: "req", id: "catalog-measure", method: "sessions.catalog.list" },
      params: { agentId: "main", limitPerHost: 16 },
      context,
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        assert.ok(ok, JSON.stringify(error));
        result = payload;
        replies++;
      },
    });
    assert.equal(replies, 1);
    assert.ok(result && typeof result === "object" && "catalogs" in result);
    const catalogs = result.catalogs as SessionCatalog[];
    assert.equal(catalogs.length, agents.length);
    for (const catalog of catalogs) {
      assert.equal(catalog.error, undefined);
      assert.equal(catalog.hosts.length, 1);
      assert.equal(catalog.hosts[0]?.sessions.length, 16);
    }
    return result;
  }
  async function golden() {
    captureGolden = true;
    try {
      return {
        response: hash("sha256", JSON.stringify(await list()), "hex"),
        entries: Object.fromEntries(entryGoldens),
      };
    } finally {
      captureGolden = false;
    }
  }
  const initialGolden = await golden();
  const warmLatency: number[] = [];
  for (let index = 0; index < 20; index++) {
    const started = performance.now();
    await list();
    warmLatency.push(performance.now() - started);
  }
  assert.deepEqual(await golden(), initialGolden);
  global.gc();
  await nextTurn();
  if (values.allocations) {
    inspector.connect();
    inspectorConnected = true;
  }
  loop.enable();
  await delay(10);
  writeSync(1, `CATALOG_READY ${JSON.stringify({ pid: process.pid, stateDir, startAt })}\n`);
  if (startAt) {
    assert.ok(Date.now() < startAt, "Missed --start-at after fixture setup and warmup");
    await delay(startAt - Date.now());
  }
  const callsBefore = providerCalls;
  const rowsBefore = providerRows;
  const revisionsBefore = providerRevisions;
  const responseSequence = createHash("sha256");
  const latency: number[] = [];
  observer.observe({ entryTypes: ["gc"] });
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  loop.reset();
  marker("heap-start");
  measuredStart = performance.now();
  for (let index = 0; index < operations; index++) {
    if (!values.unchanged) {
      const agentId = agents[index % agents.length]!;
      const rowIndex = Math.floor(index / agents.length) % sessionsPerAgent;
      replaceSessionEntrySync(
        { agentId, sessionKey: keyFor(agentId, rowIndex) },
        entryFor(agentId, rowIndex, index + 1),
      );
    }
    await projection.ensureMaterialized();
    const started = performance.now();
    const result = await list();
    latency.push(performance.now() - started);
    // Preserve every response's byte order; no volatile fields are removed.
    responseSequence.update(JSON.stringify(result)).update("\n");
    await (yieldMs ? delay(yieldMs) : nextTurn());
  }
  measuredEnd = performance.now();
  marker("heap-stop");
  const usedCpu = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  loop.disable();
  await nextTurn();
  recordGc(observer.takeRecords());
  observer.disconnect();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  if (profile) {
    writeFileSync(profilePath, JSON.stringify(profile));
  }
  const counts = {
    providerCalls: providerCalls - callsBefore,
    providerRows: providerRows - rowsBefore,
    providerRevisions: providerRevisions - revisionsBefore,
  };
  assert.equal(counts.providerCalls, operations * agents.length);
  assert.equal(counts.providerRows, operations * sessionCount);
  assert.equal(counts.providerRevisions, values.unchanged ? 0 : operations * agents.length);
  const finalGolden = await golden();
  if (values.unchanged) {
    assert.deepEqual(finalGolden, initialGolden);
  }
  const gc = (kind?: number) =>
    distribution(
      collections
        .filter((entry) => kind === undefined || entry.kind === kind)
        .map((entry) => entry.ms),
    );
  const totalGc = gc();
  const promotion = values["gc-log"]
    ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath)
    : undefined;
  const result = {
    scope:
      "in-process real sessions.catalog.list handler with persisted synthetic session rows; no transport or model latency claim",
    workload: values.unchanged ? "unchanged-warm-list" : "metadata-update-and-list",
    measurementScope:
      "Handler latency excludes the metadata write and row settling; allocation, GC, CPU and elapsed include the write, settling, response digest and pacing.",
    node: process.version,
    sessionCount,
    agents: agents.length,
    providers: agents.length,
    operations,
    yieldMs,
    startAt,
    stateDir,
    profilePath: profile ? profilePath : null,
    counts,
    golden: {
      initial: initialGolden,
      final: finalGolden,
      responseSequence: responseSequence.digest("hex"),
      omittedFields: [],
    },
    allocation: profile ? allocation(profile) : null,
    handlerLatency: distribution(latency),
    warmUnchangedLatency: distribution(warmLatency),
    elapsedMs: measuredEnd - measuredStart,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    gc: {
      total: totalGc,
      msPerOperation: totalGc.totalMs / operations,
      minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
      major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    },
    promotion: promotion
      ? { ...promotion, bytesPerOperation: promotion.promotedBytes / operations }
      : null,
    eventLoop: {
      samples: loop.count,
      maxMs: loop.max / 1e6,
      p95: { samples: loop.count, ms: loop.percentile(95) / 1e6 },
      p99: { samples: loop.count, ms: loop.percentile(99) / 1e6 },
    },
    memory: { before, after, peakRssBytesIncludingSetup: process.resourceUsage().maxRSS * 1024 },
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  writeFileSync(values.output ?? path.join(stateDir, "result.json"), output);
  writeSync(1, output);
} finally {
  observer.disconnect();
  loop.disable();
  if (inspectorConnected) {
    inspector.disconnect();
  }
  retireSessionCatalogLists(cfg);
  projection?.dispose();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
