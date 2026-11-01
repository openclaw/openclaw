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
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
    adopted: { type: "boolean", default: false },
    "empty-catalogs": { type: "boolean", default: false },
    "queue-wait-ms": { type: "string", default: "0" },
  },
});
const integer = (name: "operations" | "yield-ms" | "start-at" | "queue-wait-ms", min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const operations = integer("operations", 1);
const yieldMs = integer("yield-ms", 0);
const startAt = integer("start-at", 0);
const queueWaitMs = integer("queue-wait-ms", 0);
assert.ok(queueWaitMs < 30_000, "--queue-wait-ms must be below the 30-second queue deadline");
assert.ok(!values["empty-catalogs"] || !values.adopted, "--empty-catalogs excludes --adopted");
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
  { scheduleGatewayRequestStart },
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
  import("../../src/gateway/server/ws-connection/request-start.js"),
]);

const agents = ["main", "work"] as const;
const sessionsPerAgent = values.adopted ? 5000 : 2500;
const sessionCount = agents.length * sessionsPerAgent;
const catalogAgents = values["empty-catalogs"] ? [] : values.adopted ? [agents[0]] : agents;
const adoptionPluginId = "synthetic-main";
const adoptionHostId = "synthetic:main";
const adoptionsPerAgent = 16;
const adoption = values.adopted
  ? {
      listAdoptedSessionCatalogSessions: (await import("../../src/plugins/session-catalog.js"))
        .listAdoptedSessionCatalogSessions,
      runtime: (await import("../../src/plugins/runtime/index.js")).createPluginRuntime(),
    }
  : undefined;
const keyFor = (agentId: string, index: number) =>
  `agent:${agentId}:catalog-${String(index).padStart(4, "0")}`;
const entryFor = (agentId: string, index: number, revision = 0): SessionEntry => ({
  sessionId: `catalog-${agentId}-${index}`,
  updatedAt: 1_700_000_000_000 + index + revision * sessionCount,
  label: `Synthetic ${agentId} session ${index}, revision ${revision}`,
  ...(index % 5 === 0 ? { archivedAt: 1_700_000_000_000 + index } : {}),
  ...(values.adopted && index < adoptionsPerAgent
    ? {
        pluginOwnerId: adoptionPluginId,
        pluginExtensions: {
          [adoptionPluginId]: { sourceThreadId: `catalog-${agentId}-${index}` },
        },
      }
    : {}),
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
  let adoptedBytes = 0;
  const visit = (
    node: HeapProfiler.SamplingHeapProfileNode,
    inSelection = false,
    inCatalog = false,
    inAdopted = false,
  ) => {
    const selection =
      inSelection ||
      node.callFrame.url.includes("session-row-selection") ||
      node.callFrame.functionName === "prepareSessionRowSelection";
    const catalog =
      inCatalog || node.callFrame.url.includes("/src/gateway/server-methods/session-catalog");
    const adopted =
      inAdopted || node.callFrame.functionName === "listAdoptedSessionCatalogSessions";
    totalBytes += node.selfSize;
    selectionBytes += selection ? node.selfSize : 0;
    catalogBytes += catalog ? node.selfSize : 0;
    adoptedBytes += adopted ? node.selfSize : 0;
    node.children.forEach((child) => visit(child, selection, catalog, adopted));
  };
  visit(profile.head);
  return {
    totalBytes,
    bytesPerOperation: totalBytes / operations,
    selectionBytes,
    selectionBytesPerOperation: selectionBytes / operations,
    catalogBytes,
    catalogBytesPerOperation: catalogBytes / operations,
    adoptedBytes,
    adoptedBytesPerOperation: adoptedBytes / operations,
  };
}

let providerCalls = 0;
let providerRows = 0;
let providerRevisions = 0;
let adoptedCalls = 0;
let adoptionSourceReads = 0;
let captureGolden = false;
const lastRevisions = new Map<string, object | undefined>();
const entryGoldens = new Map<string, string>();
const nativeSessions = agents.flatMap((agentId) =>
  Array.from({ length: adoptionsPerAgent }, (_, index) => ({
    threadId: `catalog-${agentId}-${index}`,
    name: `Synthetic ${agentId} native session ${index}`,
    updatedAt: 1_700_000_000_000 + index,
    status: "stored" as const,
    archived: index % 5 === 0,
    canContinue: true,
    canArchive: false,
  })),
);
const expectedAdoptions = new Map(
  Array.from({ length: adoptionsPerAgent }, (_, index) => [
    `${adoptionHostId}\0catalog-main-${index}`,
    keyFor("main", index),
  ]),
);
const registry = createEmptyPluginRegistry();
for (const agentId of catalogAgents) {
  const provider: SessionCatalogProvider = {
    id: `synthetic-${agentId}`,
    label: `Synthetic ${agentId}`,
    list: async ({ agentId: requestedAgentId, sessionEntries, limitPerHost }) => {
      assert.ok(sessionEntries?.entriesForCatalog, "Handler must supply the planning snapshot");
      const all = sessionEntries.entriesForCatalog();
      assert.equal(all.length, sessionCount);
      const entries = adoption ? all : sessionEntries.entriesForAgent(agentId);
      if (!adoption) {
        assert.equal(entries.length, sessionsPerAgent);
        assert.equal(sessionEntries.entriesForAgent(agentId), entries);
      }
      providerCalls++;
      providerRows += entries.length;
      if (lastRevisions.get(agentId) !== sessionEntries.revision) {
        providerRevisions++;
        lastRevisions.set(agentId, sessionEntries.revision);
      }
      if (captureGolden) {
        entryGoldens.set(agentId, hash("sha256", JSON.stringify(entries), "hex"));
      }
      if (adoption) {
        assert.equal(requestedAgentId, "main");
        adoptedCalls++;
      }
      const adopted = adoption
        ? adoption.listAdoptedSessionCatalogSessions({
            agentId: requestedAgentId,
            config: cfg,
            pluginId: adoptionPluginId,
            runtime: adoption.runtime,
            sessionEntries,
            sourceFromEntry: (entry) => {
              adoptionSourceReads++;
              const sourceMarker = entry.pluginExtensions?.[adoptionPluginId];
              return isRecord(sourceMarker) && typeof sourceMarker.sourceThreadId === "string"
                ? { hostId: adoptionHostId, threadId: sourceMarker.sourceThreadId }
                : undefined;
            },
          })
        : undefined;
      if (adopted) {
        assert.deepEqual(adopted, expectedAdoptions);
      }
      return [
        {
          hostId: `synthetic:${agentId}`,
          label: `Synthetic ${agentId}`,
          kind: "gateway",
          connected: true,
          sessions: adopted
            ? nativeSessions.map((session) => ({
                ...session,
                sessionKey: adopted.get(`${adoptionHostId}\0${session.threadId}`),
              }))
            : entries.slice(0, limitPerHost).map(({ sessionKey, entry }) => ({
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
let projectionAcquisitions = 0;
let selectionPreparations = 0;
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
  const prepareSelection = projection.prepareSelection;
  projection.prepareSelection = (...args) => {
    selectionPreparations++;
    return prepareSelection(...args);
  };
  // This fixture supplies only the context fields consumed by sessions.catalog.list.
  const context = bindSessionRowProjection(
    {
      getRuntimeConfig: () => cfg,
      logGateway: createSubsystemLogger("benchmark/catalog"),
    },
    () => {
      projectionAcquisitions++;
      return projection;
    },
  ) as GatewayRequestContext;
  const handler = sessionCatalogHandlers["sessions.catalog.list"]!;
  async function list() {
    let result: unknown;
    let replies = 0;
    await handler({
      req: { type: "req", id: "catalog-measure", method: "sessions.catalog.list" },
      params: { agentId: "main", limitPerHost: adoption ? nativeSessions.length : 16 },
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
    assert.equal(catalogs.length, catalogAgents.length);
    for (const catalog of catalogs) {
      assert.equal(catalog.error, undefined);
      assert.equal(catalog.hosts.length, 1);
      assert.equal(catalog.hosts[0]?.sessions.length, adoption ? nativeSessions.length : 16);
      if (adoption) {
        const sessions = catalog.hosts[0]!.sessions;
        for (let index = 0; index < nativeSessions.length; index++) {
          const { threadId } = nativeSessions[index]!;
          assert.equal(sessions[index]?.threadId, threadId);
          assert.equal(
            sessions[index]?.sessionKey,
            expectedAdoptions.get(`${adoptionHostId}\0${threadId}`),
          );
        }
      }
    }
    return result;
  }
  const initialPending = projection.needsSelectionPreparation({ metadataOnly: true });
  const initialCpu = process.threadCpuUsage();
  const initialStarted = performance.now();
  if (values["empty-catalogs"]) {
    await list();
  }
  const initialElapsedMs = performance.now() - initialStarted;
  const initialUsedCpu = process.threadCpuUsage(initialCpu);
  const initialList = values["empty-catalogs"]
    ? {
        elapsedMs: initialElapsedMs,
        threadCpuMs: (initialUsedCpu.user + initialUsedCpu.system) / 1000,
        projectionPending: initialPending,
        projectionAcquisitions,
        selectionPreparations,
      }
    : undefined;
  // Keep warm comparisons settled; the empty-catalog initial read above owns its actual wait.
  await projection.prepareSelection();
  await projection.ensureMaterialized();
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
  const warmCpu: number[] = [];
  for (let index = 0; index < 20; index++) {
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    await list();
    warmLatency.push(performance.now() - started);
    const used = process.threadCpuUsage(cpu);
    warmCpu.push((used.user + used.system) / 1000);
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
  const adoptedCallsBefore = adoptedCalls;
  const adoptionSourceReadsBefore = adoptionSourceReads;
  const projectionAcquisitionsBefore = projectionAcquisitions;
  const selectionPreparationsBefore = selectionPreparations;
  const responseSequence = createHash("sha256");
  const latency: number[] = [];
  const handlerCpu: number[] = [];
  const queueLatency: number[] = [];
  const queueCpu: number[] = [];
  let queuedStarts = 0;
  async function admitCatalog() {
    const held = Promise.withResolvers<void>();
    const catalogSettled = Promise.withResolvers<void>();
    const starts: Promise<void>[] = [];
    let release = Promise.resolve();
    const enqueue = (
      request: Parameters<typeof scheduleGatewayRequestStart>[1],
      connection: string,
      settled: Promise<void>,
    ) => {
      const grant = scheduleGatewayRequestStart(128, request, connection, settled);
      assert.ok(grant, "Synthetic request exceeded queue capacity");
      starts.push(grant);
      queuedStarts++;
      return grant;
    };
    try {
      for (let index = 0; index < 4; index++) {
        void enqueue({ method: "models.list" }, `held-${index}`, held.promise);
      }
      await Promise.all(starts);
      void enqueue(
        { method: "sessions.messages.subscribe", params: { includeApprovals: true } },
        "catalog-client",
        Promise.resolve(),
      );
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      const grant = enqueue(
        { method: "sessions.catalog.list", params: { agentId: "main" } },
        "catalog-client",
        catalogSettled.promise,
      );
      release = delay(queueWaitMs).then(() => held.resolve());
      await grant;
      queueLatency.push(performance.now() - started);
      const used = process.threadCpuUsage(cpu);
      queueCpu.push((used.user + used.system) / 1000);
      return async () => {
        catalogSettled.resolve();
        await release;
        await Promise.all(starts);
      };
    } catch (error) {
      held.resolve();
      catalogSettled.resolve();
      await release;
      await Promise.allSettled(starts);
      throw error;
    }
  }
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
    if (!values["empty-catalogs"]) {
      await projection.ensureMaterialized();
    }
    const settleQueue = queueWaitMs ? await admitCatalog() : undefined;
    let result: Awaited<ReturnType<typeof list>>;
    try {
      const handlerCpuBefore = process.threadCpuUsage();
      const started = performance.now();
      result = await list();
      latency.push(performance.now() - started);
      const handlerCpuUsed = process.threadCpuUsage(handlerCpuBefore);
      handlerCpu.push((handlerCpuUsed.user + handlerCpuUsed.system) / 1000);
    } finally {
      await settleQueue?.();
    }
    if (values["empty-catalogs"]) {
      // Settle the same owner work on both revisions without charging it to an unrelated RPC.
      await projection.ensureMaterialized();
    }
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
    adoptedCalls: adoptedCalls - adoptedCallsBefore,
    adoptionSourceReads: adoptionSourceReads - adoptionSourceReadsBefore,
    projectionAcquisitions: projectionAcquisitions - projectionAcquisitionsBefore,
    selectionPreparations: selectionPreparations - selectionPreparationsBefore,
    queuedStarts,
  };
  assert.equal(counts.providerCalls, operations * catalogAgents.length);
  assert.equal(counts.providerRows, values["empty-catalogs"] ? 0 : operations * sessionCount);
  assert.equal(counts.providerRevisions, values.unchanged ? 0 : operations * catalogAgents.length);
  assert.equal(counts.adoptedCalls, adoption ? operations : 0);
  assert.equal(counts.queuedStarts, queueWaitMs ? operations * 6 : 0);
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
    measurementScope: values["empty-catalogs"]
      ? "Handler latency and thread CPU include its projection wait after the metadata write. Remaining row settling follows the handler; allocation, GC, process CPU and elapsed include the write, all settling, response digest and pacing."
      : "Handler latency and thread CPU exclude the metadata write and row settling; allocation, GC, process CPU and elapsed include the write, settling, response digest and pacing.",
    node: process.version,
    sessionCount,
    agents: agents.length,
    providers: catalogAgents.length,
    adopted: values.adopted,
    emptyCatalogs: values["empty-catalogs"],
    queueWaitMs,
    operations,
    yieldMs,
    startAt,
    stateDir,
    profilePath: profile ? profilePath : null,
    counts,
    // Driven workload rate; the provider has no automatic polling in this harness.
    adoptedCallsPerMinute: (counts.adoptedCalls * 60_000) / (measuredEnd - measuredStart),
    golden: {
      initial: initialGolden,
      final: finalGolden,
      responseSequence: responseSequence.digest("hex"),
      omittedFields: [],
    },
    allocation: profile ? allocation(profile) : null,
    initialList,
    handlerLatency: distribution(latency),
    handlerThreadCpu: distribution(handlerCpu),
    queueLatency: distribution(queueLatency),
    queueThreadCpu: distribution(queueCpu),
    warmUnchangedLatency: distribution(warmLatency),
    warmUnchangedThreadCpu: distribution(warmCpu),
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
