// Own synthetic state only. Run with node --import ./scripts/tsx.mjs.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { finished as streamFinished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stripInboundMetadata } from "../../src/auto-reply/reply/strip-inbound-meta.js";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import {
  readMockUserText,
  summarizeMockInferenceRequest,
} from "../e2e/lib/mock-inference-facts.ts";
import { readBody } from "../e2e/lib/mock-openai-http.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { buildGatewayBenchChildArgs, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
} from "../lib/managed-child-process.mts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    port: { type: "string", default: "41058" },
    "mock-port": { type: "string", default: "41059" },
    clients: { type: "string" },
    "reconnect-waves": { type: "boolean", default: false },
    "cold-row-reads": { type: "boolean", default: false },
    "startup-admission": { type: "boolean", default: false },
    "request-start-owner": { type: "string" },
    "row-refresh-owner": { type: "string" },
    "trace-gc": { type: "boolean", default: false },
    "reconnect-count": { type: "string" },
    waves: { type: "string", default: "10" },
    "start-at": { type: "string" },
    runs: { type: "string", default: "30" },
    seconds: { type: "string", default: "300" },
    "poll-ms": { type: "string", default: "5000" },
    "writer-reads": { type: "boolean", default: false },
    "worktree-churn": { type: "boolean", default: false },
    "cheap-handlers": { type: "boolean", default: false },
    "transcript-reads": { type: "boolean", default: false },
    "sqlite-queues": { type: "boolean", default: false },
  },
});
if (!values["state-dir"]) {
  throw new Error("--state-dir is required (an offline, generated team-shape fixture)");
}
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const port = integer(values.port, "--port", 40000);
const mockPort = integer(values["mock-port"], "--mock-port", 40000);
if (port > 65535 || mockPort > 65535 || port === mockPort) {
  throw new Error("ports must be distinct and between 40000 and 65535");
}
const reconnectWaves = values["reconnect-waves"];
const coldRowReads = values["cold-row-reads"];
const startupAdmission = values["startup-admission"];
if (startupAdmission && !coldRowReads) {
  throw new Error("--startup-admission requires --cold-row-reads");
}
if (values["request-start-owner"] && !startupAdmission) {
  throw new Error("--request-start-owner requires --startup-admission");
}
const requestStartOwner = startupAdmission
  ? path.resolve(
      values["request-start-owner"] ?? "src/gateway/server/ws-connection/request-start.ts",
    )
  : undefined;
const requestStartOwnerSha256 = requestStartOwner
  ? createHash("sha256").update(readFileSync(requestStartOwner)).digest("hex")
  : undefined;
if ((values["row-refresh-owner"] || values["trace-gc"]) && !coldRowReads) {
  throw new Error("--row-refresh-owner and --trace-gc require --cold-row-reads");
}
const rowRefreshOwner = coldRowReads
  ? path.resolve(values["row-refresh-owner"] ?? "src/gateway/session-row-projection-refresh.ts")
  : undefined;
const rowRefreshOwnerSha256 = rowRefreshOwner
  ? createHash("sha256").update(readFileSync(rowRefreshOwner)).digest("hex")
  : undefined;
const clientCount = integer(
  values.clients ?? (coldRowReads ? "70" : reconnectWaves ? "40" : "50"),
  "--clients",
);
const reconnectCount = values["reconnect-count"]
  ? integer(values["reconnect-count"], "--reconnect-count")
  : Math.min(30, clientCount - 1);
const waveCount = integer(values.waves, "--waves");
const measurementStartAt = values["start-at"]
  ? integer(values["start-at"], "--start-at")
  : undefined;
if (measurementStartAt !== undefined && !reconnectWaves && !coldRowReads) {
  throw new Error("--start-at requires --reconnect-waves or --cold-row-reads");
}
if (
  coldRowReads &&
  (reconnectWaves ||
    values["writer-reads"] ||
    values["worktree-churn"] ||
    values["cheap-handlers"] ||
    values["transcript-reads"] ||
    values["sqlite-queues"])
) {
  throw new Error("--cold-row-reads cannot be combined with another workload mode");
}
if (values["reconnect-count"] !== undefined && !reconnectWaves) {
  throw new Error("--reconnect-count requires --reconnect-waves");
}
if (reconnectWaves && reconnectCount >= clientCount) {
  throw new Error("--reconnect-count must be less than --clients to retain background traffic");
}
if (
  reconnectWaves &&
  (clientCount < 2 ||
    values["writer-reads"] ||
    values["worktree-churn"] ||
    values["cheap-handlers"] ||
    values["transcript-reads"] ||
    values["sqlite-queues"])
) {
  throw new Error("--reconnect-waves requires at least two clients and no restart workload flags");
}
const runCount = integer(values.runs, "--runs");
const durationMs = integer(values.seconds, "--seconds") * 1000;
const pollMs = integer(values["poll-ms"], "--poll-ms");
if (values["worktree-churn"] && durationMs < 180_000) {
  throw new Error(
    "--worktree-churn requires --seconds at least 180 for a separate post-reconnect burst",
  );
}
const root = path.resolve(values["state-dir"]);
const fixture: unknown = JSON.parse(
  readFileSync(path.join(root, "team-shape-summary.json"), "utf8"),
);
if (!isRecord(fixture) || fixture.format !== "openclaw-team-shape-v1") {
  throw new Error("--state-dir must contain a generated team-shape fixture; never use live state");
}
if (
  coldRowReads &&
  (fixture.sessionCount !== 5000 || (fixture.retainedRuns !== 0 && fixture.settledRuns !== true))
) {
  throw new Error("--cold-row-reads requires 5000 sessions and --settled-runs (or --runs 0)");
}
if (startupAdmission && 1 + 10 * (clientCount - 1) > 5000) {
  throw new Error("--startup-admission requires at most 500 clients for distinct shared sessions");
}
const worktreeProject = Array.isArray(fixture.projectWorktrees)
  ? fixture.projectWorktrees[0]
  : undefined;
const worktreeProjectId =
  isRecord(worktreeProject) && typeof worktreeProject.projectId === "string"
    ? worktreeProject.projectId
    : undefined;
if (values["worktree-churn"] && !worktreeProjectId) {
  throw new Error("Worktree churn requires a seeded project");
}
const output = path.join(root, `post-restart-burst-${Date.now()}`);
mkdirSync(output);
const cfg = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
const token = "synthetic-post-restart-burst-token";
cfg.gateway = { ...cfg.gateway, auth: { mode: "token", token } };
if (reconnectWaves) {
  cfg.gateway.trustedProxies = ["127.0.0.1", "::1"];
}
if (!coldRowReads) {
  applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
}
cfg.agents.defaults = { ...cfg.agents.defaults, maxConcurrent: runCount, skipBootstrap: true };
cfg.memory = { ...cfg.memory, search: { enabled: false } };
cfg.tools = { codeMode: false };
cfg.plugins = coldRowReads
  ? { enabled: false }
  : {
      ...cfg.plugins,
      enabled: true,
      entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
    };
if (
  values["writer-reads"] ||
  values["cheap-handlers"] ||
  values["transcript-reads"] ||
  values["worktree-churn"]
) {
  cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
  cfg.plugins.entries["diagnostics-prometheus"] = { enabled: true };
}
if (values["sqlite-queues"]) {
  cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
}
if (values["cheap-handlers"]) {
  cfg.plugins.entries.github = { enabled: true };
  cfg.plugins.entries.workboard = { enabled: true };
}
if (values["transcript-reads"]) {
  cfg.plugins.entries.workboard = { enabled: true };
}
const previewUrl = "https://github.com/openclaw-fixture/restart/issues/1";
const previewTitle = "Synthetic post-restart issue";
const catalogId = "synthetic-restart-catalog";
const pluginDir = path.join(output, catalogId);
if (!coldRowReads) {
  mkdirSync(pluginDir);
  writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: catalogId,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  writeFileSync(
    path.join(pluginDir, "index.mjs"),
    `export default {
  id: '${catalogId}', register(api) {
    ${
      values["writer-reads"]
        ? `const store = api.runtime.state.openKeyedStoreV2({ namespace: 'restart-catalog', maxEntries: 10, overflowPolicy: 'reject-new' });
    api.registerService({ id: 'synthetic-catalog-state', async start() {
      if (!(await store.lookup('metadata'))) await store.register('metadata', { label: 'Synthetic metadata' });
    } });`
        : ""
    }
    api.registerSessionCatalog({ id: '${catalogId}', label: 'Synthetic restart metadata catalog',
      audience: 'gateway-operators', supportsProcessHomeIsolation: true,
      list: async (query) => {
        ${values["writer-reads"] ? `if (!(await store.lookup('metadata'))) throw new Error('Synthetic catalog state missing');` : ""}
        const entries = query.sessionEntries?.entriesForAgent(query.agentId ?? 'main');
        if (!entries?.length) throw new Error('Synthetic catalog requires populated session metadata');
        return [{ hostId: 'gateway:local', label: 'Synthetic metadata', kind: 'gateway', connected: true,
          sessions: entries.slice(0, query.limitPerHost ?? 100).map(({ sessionKey, entry }) => ({
            threadId: sessionKey, sessionKey, name: entry.displayName ?? 'Synthetic session', status: 'idle',
            archived: false, canContinue: false, canArchive: false })) }];
      }, read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    });
  },
};\n`,
  );
  cfg.plugins.load = {
    ...cfg.plugins.load,
    paths: [...(cfg.plugins.load?.paths ?? []), pluginDir],
  };
  cfg.plugins.entries = { ...cfg.plugins.entries, [catalogId]: { enabled: true } };
}
const configPath = path.join(output, "openclaw.json");
writeFileSync(configPath, JSON.stringify(cfg));
// Private IPC only, no inspector listener or product RPC. Deltas include startup and recovery.
const preloadPath = path.join(output, "elu-preload.mjs");
writeFileSync(
  preloadPath,
  `import { performance, monitorEventLoopDelay, PerformanceObserver, constants } from 'node:perf_hooks';
import { isMainThread, MessagePort } from 'node:worker_threads';
if (isMainThread) {
  if (!process.send) throw new Error('Benchmark requires private IPC');
  ${
    coldRowReads
      ? `const { registerHooks, stripTypeScriptTypes } = await import('node:module');
  const { readFileSync, writeSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const rowOwnerPath = ${JSON.stringify(rowRefreshOwner)};
  const rowOwnerSha256 = ${JSON.stringify(rowRefreshOwnerSha256)};
  const rowCounts = { active: false, selectPage: 0, taskSamples: 0, taskMaxMs: 0, taskName: null, taskPhase: null };
  Object.defineProperty(globalThis, Symbol.for('openclaw.bench.cold-row-counts'), { value: rowCounts });
  const admissionSamples = new Map();
  let admissionSampleCount = 0;
  let admissionOverflow = false;
  const recordAdmissionSample = (key, ms) => {
    if (!rowCounts.active || !Number.isFinite(ms)) return;
    if (admissionSampleCount >= 200000) { admissionOverflow = true; return; }
    const samples = admissionSamples.get(key) ?? [];
    if (!admissionSamples.has(key)) admissionSamples.set(key, samples);
    samples.push(ms);
    admissionSampleCount++;
  };
  if (${startupAdmission}) {
    const { channel } = await import('node:diagnostics_channel');
    const methods = new Set(['models.list', 'sessions.subscribe', 'sessions.list', 'board.get', 'sessions.resolve', 'sessions.messages.subscribe', 'chat.startup']);
    channel('openclaw.gateway.rpc').subscribe((event) => {
      if (!rowCounts.active || !methods.has(event.method)) return;
      if (event.phase === 'dispatch') recordAdmissionSample(event.method + ':queue_wait', event.queueWaitMs);
      if (event.phase === 'handler') {
        recordAdmissionSample(event.method + ':admission', event.admissionMs);
        recordAdmissionSample(event.method + ':handler', event.durationMs);
      }
      if (event.phase === 'response' && event.firstResponse) recordAdmissionSample(event.method + ':first_response', event.durationMs);
    });
    rowCounts.startSpan = (name) => {
      if (!rowCounts.active || (!name.startsWith('gateway.chat.startup.') && !name.startsWith('startup-boundary.'))) return undefined;
      const startedAt = performance.now();
      return { [Symbol.dispose]() { recordAdmissionSample(name, performance.now() - startedAt); } };
    };
  }
  let rowOwnerLoaded = false;
  let rowSelectionHookLoaded = false;
  let rowTaskHookLoaded = false;
  let startupSpanHookLoaded = false;
  let requestStartOwnerLoaded = false;
  const markColdGc = (phase) => {
    if (${values["trace-gc"]}) writeSync(1, ${JSON.stringify(GATEWAY_GC_TRACE_MARKER)} + JSON.stringify({ phase, pid: process.pid, profilePath: 'cold-rows' }) + '\\n');
  };
  if (${values["trace-gc"]}) {
    if (typeof globalThis.gc !== 'function') throw new Error('Cold-row trace requires --expose-gc');
    markColdGc('identify-start');
    globalThis.gc();
    markColdGc('identify-stop');
  }
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (${startupAdmission} && url.endsWith('/src/gateway/server/ws-connection/request-start.ts')) {
      const source = readFileSync(${JSON.stringify(requestStartOwner)}, 'utf8');
      if (createHash('sha256').update(source).digest('hex') !== ${JSON.stringify(requestStartOwnerSha256)}) {
        throw new Error('Request start owner changed after measurement preparation');
      }
      requestStartOwnerLoaded = true;
      return { ...loaded, source: stripTypeScriptTypes(source) };
    }
    if (url.endsWith('/src/gateway/session-row-projection-refresh.ts')) {
      const source = readFileSync(rowOwnerPath, 'utf8');
      if (createHash('sha256').update(source).digest('hex') !== rowOwnerSha256) {
        throw new Error('Row refresh owner changed after measurement preparation');
      }
      loaded.source = stripTypeScriptTypes(source);
      rowOwnerLoaded = true;
      process.stdout.write('COLD_ROWS_OWNER ' + JSON.stringify({ path: rowOwnerPath, sha256: rowOwnerSha256 }) + '\\n');
    }
    if (url.endsWith('/src/gateway/session-utils-list.ts')) {
      let source = stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'));
      const selection = /const selectPage\\s*=\\s*\\(\\)\\s*=>\\s*\\{/;
      if (!selection.test(source)) throw new Error('Missing selectPage source counter hook');
      source = source.replace(selection, '$&if (globalThis[Symbol.for("openclaw.bench.cold-row-counts")].active) globalThis[Symbol.for("openclaw.bench.cold-row-counts")].selectPage++;');
      rowSelectionHookLoaded = true;
      return { ...loaded, source };
    }
    if (url.endsWith('/src/infra/main-thread-stall.ts')) {
      let source = stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'));
      const task = /function runWithMainThreadTask\\s*\\([^)]*\\)\\s*\\{/;
      if (!task.test(source)) throw new Error('Missing runWithMainThreadTask source hook');
      source = source.replace(task, '$&const probe = globalThis[Symbol.for("openclaw.bench.cold-row-counts")]; if (probe.active) { const originalRun = run; run = () => { const at = performance.now(); try { return originalRun(); } finally { const ms = performance.now() - at; probe.taskSamples++; if (ms > probe.taskMaxMs) { probe.taskMaxMs = ms; probe.taskName = name.slice(0, 160); probe.taskPhase = phase?.slice(0, 160) ?? null; } } }; }');
      rowTaskHookLoaded = true;
      return { ...loaded, source };
    }
    if (${startupAdmission} && url.endsWith('/src/infra/diagnostics-timeline.ts')) {
      let source = stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'));
      const span = /function measureDiagnosticsTimelineSpan(?:Sync)?\\s*\\([^)]*\\)\\s*\\{/g;
      if ([...source.matchAll(span)].length !== 2) throw new Error('Missing chat startup timeline span hooks');
      source = source.replace(span, '$&using benchmarkSpan = globalThis[Symbol.for("openclaw.bench.cold-row-counts")].startSpan(name);');
      startupSpanHookLoaded = true;
      return { ...loaded, source };
    }
    if (${startupAdmission}) {
      const boundary = url.endsWith('/src/gateway/server-methods/chat-pending-inputs.ts')
        ? ['readChatPendingInputs', 'pending_inputs']
        : url.endsWith('/src/agents/subagents/registry/subagent-registry-state.ts')
          ? ['prepareOptionalSubagentSessionListReadCache', 'subagent_snapshot'] : undefined;
      if (boundary) {
        let source = stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'));
        const start = new RegExp('async function ' + boundary[0] + '\\\\s*\\\\([^)]*\\\\)\\\\s*\\\\{');
        if (!start.test(source)) throw new Error('Missing startup boundary hook: ' + boundary[0]);
        source = source.replace(start, '$&using benchmarkSpan = globalThis[Symbol.for("openclaw.bench.cold-row-counts")].startSpan("startup-boundary.' + boundary[1] + '");');
        return { ...loaded, source };
      }
    }
    return loaded;
  } });`
      : ""
  }
  ${
    values["sqlite-queues"]
      ? `if (process.env.OPENCLAW_BENCH_QUEUE_START_NS) {
    const { onInternalDiagnosticEvent, setDiagnosticsEnabledForProcess, waitForDiagnosticEventsDrained } =
      await import(${JSON.stringify(new URL("../../src/infra/diagnostic-events.ts", import.meta.url).href)});
    const { deserialize } = await import('node:v8');
    const startNs = BigInt(process.env.OPENCLAW_BENCH_QUEUE_START_NS);
    const startWall = Number(process.env.OPENCLAW_BENCH_QUEUE_START_WALL_MS);
    const windowMs = ${durationMs};
    const binMs = Math.max(10000, Math.ceil(windowMs / 180));
    const elapsed = () => Number(process.hrtime.bigint() - startNs) / 1e6;
    const captureStartedMs = elapsed();
    const groups = new Map();
    const sharedSqliteKinds = new Set(['sqlite_writer', 'sqlite_read', 'stateRead']);
    const eventSamples = [];
    const commandCounts = new Map();
    let events = 0;
    let droppedDiagnosticEvents = 0;
    let inconsistentDepths = 0;
    let overflow = false;
    let maxDeliveryDelayMs = 0;
    let maxClockSkewMs = 0;
    let lastEventMs = 0;
    const group = (key, kind, requestClass) => {
      let row = groups.get(key);
      if (!row && groups.size < 512) {
        row = { kind, requestClass, queued: 0, started: 0, completed: 0, cancelledBeforeStart: 0,
          queueDepth: 0, active: 0, maxQueueDepth: 0, maxActive: 0,
          queuedTimeMs: 0, serviceTimeMs: 0, startedQueueWaitMs: 0,
          maxQueueWaitMs: 0, completedDurationMs: 0, at: 0, bins: [] };
        groups.set(key, row);
      }
      if (!row) overflow = true;
      return row;
    };
    const advance = (row, at) => {
      at = Math.max(row.at, Math.min(windowMs, at));
      while (row.at < at) {
        const index = Math.floor(row.at / binMs);
        const until = Math.min(at, (index + 1) * binMs);
        const bin = row.bins[index] ??= { fromMs: index * binMs,
          toMs: Math.min(windowMs, (index + 1) * binMs), queuedTimeMs: 0, serviceTimeMs: 0,
          maxQueueDepth: row.queueDepth };
        const wait = (until - row.at) * row.queueDepth;
        const service = (until - row.at) * row.active;
        row.queuedTimeMs += wait; row.serviceTimeMs += service;
        bin.queuedTimeMs += wait; bin.serviceTimeMs += service;
        bin.maxQueueDepth = Math.max(bin.maxQueueDepth, row.queueDepth);
        row.at = until;
      }
    };
    setDiagnosticsEnabledForProcess(true);
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === 'diagnostic.async_queue.dropped') {
        droppedDiagnosticEvents += event.droppedEvents;
        return;
      }
      if (event.type !== 'worker.request') return;
      const observedMs = elapsed();
      const eventMs = event.ts - startWall;
      if (eventMs < 0 || eventMs >= windowMs) return;
      events++;
      maxDeliveryDelayMs = Math.max(maxDeliveryDelayMs, observedMs - eventMs);
      maxClockSkewMs = Math.max(maxClockSkewMs, Math.abs(Date.now() - startWall - observedMs));
      if (eventMs < lastEventMs) inconsistentDepths++;
      lastEventMs = Math.max(lastEventMs, eventMs);
      const owner = group('kind:' + event.kind, event.kind);
      const request = group('class:' + event.kind + ':' + event.requestClass, event.kind, event.requestClass);
      const total = group('total', 'all');
      if (!owner || !request || !total) return;
      const shared = sharedSqliteKinds.has(event.kind) ? group('shared', 'sharedSqlite') : undefined;
      const queueDelta = event.phase === 'queued' ? 1
        : event.phase === 'started' || (event.phase === 'completed' && event.durationMs === undefined) ? -1 : 0;
      const activeDelta = event.phase === 'started' ? 1
        : event.phase === 'completed' && event.durationMs !== undefined ? -1 : 0;
      for (const row of [owner, request, total, ...(shared ? [shared] : [])]) {
        advance(row, eventMs);
        row.queueDepth += queueDelta; row.active += activeDelta;
        if (row.queueDepth < 0 || row.active < 0) inconsistentDepths++;
        row.maxQueueDepth = Math.max(row.maxQueueDepth, row.queueDepth);
        const index = Math.floor(eventMs / binMs);
        const bin = row.bins[index] ??= { fromMs: index * binMs,
          toMs: Math.min(windowMs, (index + 1) * binMs), queuedTimeMs: 0, serviceTimeMs: 0,
          maxQueueDepth: 0 };
        bin.maxQueueDepth = Math.max(bin.maxQueueDepth, row.queueDepth);
        row.maxActive = Math.max(row.maxActive, row.active);
        row[event.phase]++;
        if (event.phase === 'completed' && event.durationMs === undefined) row.cancelledBeforeStart++;
        row.startedQueueWaitMs += event.queueWaitMs ?? 0;
        row.maxQueueWaitMs = Math.max(row.maxQueueWaitMs, event.queueWaitMs ?? 0);
        row.completedDurationMs += event.durationMs ?? 0;
      }
      if (owner.queueDepth !== event.queueDepth) inconsistentDepths++;
      if (eventSamples.length < 2000) eventSamples.push({ observedMs, eventMs, kind: event.kind,
        requestClass: event.requestClass, phase: event.phase, queueDepth: event.queueDepth,
        queueWaitMs: event.queueWaitMs, durationMs: event.durationMs });
    }, { include: ['worker.request', 'diagnostic.async_queue.dropped'] });
    const worktreeCommands = new Set(['abortRemoval', 'admitRunLease', 'assertPredicates', 'claimRemoval',
      'cleanupState', 'deferCleanup', 'delete', 'finalizeRemoval', 'findLiveByOwner', 'findLiveByPath',
      'get', 'insert', 'list', 'liveIds', 'pendingSlots', 'provisionedChunk', 'provisionedPaths',
      'provisionedState', 'reapRunLeases', 'recoverPending', 'releasePending', 'releaseRunLease',
      'reserveCapacity', 'reservePending', 'retireMissing', 'sessionBinding', 'slotCount', 'update',
      'writeProvisionedSnapshot'].map((name) => 'worktrees.' + name));
    const queueNativePost = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message, ...args) {
      const body = message?.type === 'post' ? message.value : message;
      if (elapsed() < windowMs && body?.type === 'execute' && body.input instanceof Uint8Array) {
        const request = deserialize(body.input);
        const command = request.command ?? request;
        if (worktreeCommands.has(command.type)) commandCounts.set(command.type, (commandCounts.get(command.type) ?? 0) + 1);
      }
      return queueNativePost.call(this, message, ...args);
    };
    setTimeout(async () => {
      await waitForDiagnosticEventsDrained();
      unsubscribe();
      for (const row of groups.values()) advance(row, windowMs);
      const rows = [...groups.values()].map(({ at, ...row }) => row);
      process.send?.({ channel: 'post-restart-burst-sqlite-queues', pid: process.pid, report: {
        windowMs, binMs, captureStartedMs, snapshotObservedMs: elapsed(), events,
        complete: events > 0 && !overflow && !droppedDiagnosticEvents && !inconsistentDepths && maxClockSkewMs < 100,
        overflow, droppedDiagnosticEvents, inconsistentDepths, maxDeliveryDelayMs, maxClockSkewMs,
        total: rows.find((row) => row.kind === 'all'),
        totalBoundary: 'sum of all instrumented worker-kind queues; overlapping, not one FIFO or exclusively SQLite',
        sharedSqliteKinds: [...sharedSqliteKinds],
        sharedSqlite: rows.find((row) => row.kind === 'sharedSqlite'),
        kinds: rows.filter((row) => row.kind !== 'all' && row.kind !== 'sharedSqlite' && row.requestClass === undefined),
        classes: rows.filter((row) => row.requestClass !== undefined).sort((a, b) => b.queuedTimeMs - a.queuedTimeMs),
        worktreeCommandDispatchCounts: Object.fromEntries(commandCounts), eventSamples,
        eventSamplesTruncated: events > eventSamples.length,
      } });
    }, Math.max(0, windowMs - elapsed())).unref();
  }`
      : ""
  }
  ${
    values["cheap-handlers"]
      ? `const { MockAgent } = await import(${JSON.stringify(import.meta.resolve("undici"))});
  const transport = new MockAgent();
  transport.disableNetConnect();
  const github = transport.get('https://api.github.com');
  const repository = '/repos/openclaw-fixture/restart';
  github.intercept({ path: repository, method: 'GET' }).reply(200, {
    private: false, visibility: 'public', full_name: 'openclaw-fixture/restart',
  }).persist();
  github.intercept({ path: repository + '/issues/1', method: 'GET' }).reply(() => {
    process.send?.({ channel: 'post-restart-burst-github-fixture', pid: process.pid });
    return { statusCode: 200, data: JSON.stringify({
      title: ${JSON.stringify(previewTitle)}, state: 'open', number: 1,
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
      repository_url: 'https://api.github.com' + repository,
      user: { login: 'synthetic-user' }, comments: 0,
    }), responseOptions: { headers: { 'content-type': 'application/json' } } };
  }).persist();
  // Gateway startup replaces recognized global agents; bind this fixture per fetch instead.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === 'https://api.github.com') {
      return nativeFetch(input, { ...options, dispatcher: transport });
    }
    if (url.hostname !== '127.0.0.1') throw new Error('Benchmark blocked external fetch');
    return nativeFetch(input, options);
  };`
      : ""
  }
  const taskCounts = new Map();
  const captureUntil = Number(process.env.OPENCLAW_BENCH_CAPTURE_DEADLINE_MS);
  const nativePost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function(message, ...args) {
    const body = message?.type === 'post' ? message.value : message;
    if (Date.now() < captureUntil && typeof body?.taskId === 'number' && body.responseId === undefined && body.input) {
      const kind = body.input.kind;
      const request = body.input.request?.kind;
      if (typeof kind === 'string' && /^[a-z-]{1,80}$/.test(kind) && (taskCounts.has(kind) || taskCounts.size < 128)) {
        const input = body.input;
        const label = kind === 'session-exact-entries'
          ? [kind, input.projection ?? 'full', input.selection?.kind ?? 'keys',
              input.snapshotFields?.length === 0 ? 'metadata' : 'snapshots',
              input.transcript ? 'transcript' : 'entry',
              input.includeMembers ? 'members' : 'no-members',
              input.includeAuthorization ? 'authorization' : 'no-authorization'].join(':')
          : kind === 'history-page' && typeof request === 'string' && /^[a-z-]{1,80}$/.test(request)
            ? kind + ':' + request : kind;
        taskCounts.set(label, (taskCounts.get(label) ?? 0) + 1);
      }
    }
    return nativePost.call(this, message, ...args);
  };
  process.on('message', (message) => {
    if (message?.channel === 'post-restart-burst-snapshot') {
      process.send?.({ channel: 'post-restart-burst-tasks', pid: process.pid,
        taskCounts: Object.fromEntries(taskCounts) });
    }
  });
  let before = performance.eventLoopUtilization();
  let at = performance.now();
  let cpu = process.threadCpuUsage();
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  ${
    coldRowReads
      ? `const coldLag = monitorEventLoopDelay({ resolution: 10 });
  const coldCollections = [];
  let coldStartedAt = Infinity;
  let coldFinishedAt = Infinity;
  let coldThreadCpu;
  let coldProcessCpu;
  const collectColdGc = (entries) => {
    for (const entry of entries) {
      if (entry.startTime >= coldStartedAt && entry.startTime < coldFinishedAt) {
        coldCollections.push({ kind: entry.detail.kind, ms: entry.duration });
      }
    }
  };
  const coldGcObserver = new PerformanceObserver((list) => collectColdGc(list.getEntries()));
  coldGcObserver.observe({ entryTypes: ['gc'] });
  const gcSummary = (kind) => {
    const pauses = coldCollections.filter((entry) => kind === undefined || entry.kind === kind).map((entry) => entry.ms).sort((a, b) => a - b);
    const percentile = (fraction) => pauses[Math.max(0, Math.ceil(pauses.length * fraction) - 1)] ?? null;
    return { samples: pauses.length, totalMs: pauses.reduce((sum, ms) => sum + ms, 0), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: pauses.at(-1) ?? null };
  };
  process.on('message', async (message) => {
    if (message?.channel === 'cold-rows-ready') {
      markColdGc('diagnostics-start');
      coldStartedAt = performance.now();
      coldThreadCpu = process.threadCpuUsage();
      coldProcessCpu = process.cpuUsage();
      rowCounts.active = true;
      coldLag.enable();
      process.send?.({ channel: 'cold-rows-ready', pid: process.pid });
    }
    if (message?.channel === 'cold-rows-finish') {
      coldFinishedAt = performance.now();
      const threadCpu = process.threadCpuUsage(coldThreadCpu);
      const processCpu = process.cpuUsage(coldProcessCpu);
      markColdGc('diagnostics-stop');
      rowCounts.active = false;
      coldLag.disable();
      await new Promise(setImmediate);
      collectColdGc(coldGcObserver.takeRecords());
      coldGcObserver.disconnect();
      if (!rowOwnerLoaded || !rowSelectionHookLoaded || !rowTaskHookLoaded || rowCounts.selectPage === 0 || rowCounts.taskSamples === 0) {
        throw new Error('Cold row measurement did not load the selected owner, selection, and task hooks');
      }
      if (${startupAdmission} && (!requestStartOwnerLoaded || !startupSpanHookLoaded || admissionOverflow || !admissionSamples.has('chat.startup:handler'))) {
        throw new Error('Startup admission diagnostics are incomplete');
      }
      const admission = ${startupAdmission} ? Object.fromEntries([...admissionSamples].map(([key, samples]) => {
        samples.sort((a, b) => a - b);
        const percentile = (fraction) => samples[Math.max(0, Math.ceil(samples.length * fraction) - 1)] ?? null;
        return [key, { samples: samples.length, totalMs: samples.reduce((sum, ms) => sum + ms, 0), p50Ms: percentile(0.5), p90Ms: percentile(0.9), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: samples.at(-1) ?? null }];
      })) : undefined;
      process.send?.({ channel: 'cold-rows-loop', pid: process.pid,
        samples: coldLag.count, p95Ms: coldLag.percentile(95)/1e6,
        p99Ms: coldLag.percentile(99)/1e6, maxMs: coldLag.max/1e6,
        mainThreadCpuMs: (threadCpu.user + threadCpu.system)/1000,
        processCpuMs: (processCpu.user + processCpu.system)/1000,
        selectPageCalls: rowCounts.selectPage, rowOwnerSha256,
        admission,
        synchronousTasks: { samples: rowCounts.taskSamples, maxMs: rowCounts.taskMaxMs, task: rowCounts.taskName, phase: rowCounts.taskPhase, boundary: 'inclusive synchronous runWithMainThreadTask callbacks; nested scopes may overlap' },
        gc: { scope: 'main-isolate', all: gcSummary(), minor: gcSummary(constants.NODE_PERFORMANCE_GC_MINOR), major: gcSummary(constants.NODE_PERFORMANCE_GC_MAJOR) } });
    }
  });`
      : ""
  }
  setInterval(() => {
    const now = performance.now();
    const after = performance.eventLoopUtilization();
    const nextCpu = process.threadCpuUsage();
    process.send?.({ channel: 'post-restart-burst-elu', pid: process.pid,
      intervalMs: now-at, elu: performance.eventLoopUtilization(after, before).utilization,
      loopDelayMaxMs: lag.max/1e6, mainThreadCpuMs: ((nextCpu.user-cpu.user)+(nextCpu.system-cpu.system))/1000 });
    before = after; at = now; cpu = nextCpu; lag.reset();
  }, 5000).unref();
  process.channel?.unref();
}
`,
);
const env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
  ...(!coldRowReads ? { OPENAI_API_KEY: "synthetic-fixture" } : {}),
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_PROFILE: `team-shape-${port}`,
  OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-team-shape-${port}`,
  OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.team-shape-${port}`,
  OPENCLAW_WINDOWS_TASK_NAME: `OpenClaw Gateway (team-shape-${port})`,
};
const cohort = randomUUID();
const message = (index: number) =>
  `Reply with benchmark stream ${index}. Post-restart cohort ${cohort}.`;
const initialArrivals = new Set<number>();
const heldResponses = new Map<number, ServerResponse>();
const recoveryArrivals = new Set<number>();
let crashExpected = false;
let activePrimaryHoldsAtCrash: number;
let recovering = false;
let failure: Error | undefined;
let gateway: ChildProcess | undefined;
let restartAt = 0;
let loadStartedAt = Number.POSITIVE_INFINITY;
let closing = false;
const children: ChildProcess[] = [];
const childLogs = new Map<ChildProcess, ReturnType<typeof createWriteStream>>();
const expectedExits = new Set<ChildProcess>();
const listeners = new Set<ChildProcess>();
const clients = new Set<ReturnType<typeof createGatewayWsClient>>();
type EluSample = {
  elapsedMs: number;
  intervalMs: number;
  elu: number;
  loopDelayMaxMs: number;
  mainThreadCpuMs: number;
};
const eluSamples: EluSample[] = [];
const transcriptSnapshot = Promise.withResolvers<Record<string, number>>();
const sqliteQueueSnapshot = Promise.withResolvers<Record<string, unknown>>();
const coldRowsReady = Promise.withResolvers<void>();
const coldRowsLoop = Promise.withResolvers<{
  samples: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  mainThreadCpuMs: number;
  processCpuMs: number;
  selectPageCalls: number;
  rowOwnerSha256: string;
  gc: Record<string, unknown>;
  synchronousTasks: Record<string, unknown>;
  admission?: Record<string, unknown>;
}>();
let githubFixtureRequests = 0;
let vapidPublicKey: string | undefined;
let timeToSteadyMs: number | null = null;
let consecutiveLowSamples = 0;
const mock = createServer((req, res) => {
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  void (async () => {
    const body: unknown = JSON.parse(await readBody(req));
    const facts = summarizeMockInferenceRequest(body);
    const input = isRecord(body) ? (body.input ?? body.messages) : undefined;
    const lastUser = Array.isArray(input)
      ? input
          .toReversed()
          .map(readMockUserText)
          .find((text) => text !== undefined)
      : undefined;
    const index = facts.turnIndex;
    const primary =
      facts.purpose === "benchmark-turn" &&
      !facts.hasToolOutput &&
      index !== undefined &&
      index >= 1 &&
      index <= runCount &&
      lastUser !== undefined &&
      stripInboundMetadata(lastUser).trim() === message(index);
    if (primary) {
      const arrivals = recovering ? recoveryArrivals : initialArrivals;
      if (!recovering && arrivals.has(index)) {
        throw new Error(`duplicate initial primary model request ${index}`);
      }
      arrivals.add(index);
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (primary && !recovering) {
      // Hold actual agent execution until the owned Gateway is killed, without completing its turn.
      heldResponses.set(index, res);
      res.flushHeaders();
      await new Promise<void>((resolve) => {
        const onClose = () => {
          heldResponses.delete(index);
          if (!crashExpected && !closing) {
            failure ??= new Error(`primary model request ${index} closed before the owned crash`);
          }
          resolve();
        };
        res.once("close", onClose);
        if (res.destroyed) {
          res.off("close", onClose);
          onClose();
        }
      });
      return;
    }
    const text = "Synthetic recovery acknowledgement.";
    const item = {
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    for (const event of [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text,
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: `resp_${randomUUID()}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
        },
      },
    ]) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  })().catch((error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    res.destroy();
  });
});
function assertAlive() {
  if (failure) {
    throw failure;
  }
  if (!gateway?.connected || gateway.exitCode !== null || gateway.signalCode !== null) {
    throw new Error(`owned Gateway exited; inspect ${output}`);
  }
}
async function assertPortAvailable(targetPort: number) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(targetPort, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
}
function launch(name: string) {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const args = buildGatewayBenchChildArgs(values.entry, port, [
    ...(values["trace-gc"] ? ["--expose-gc", "--trace-gc-nvp"] : []),
    "--import",
    "./scripts/tsx.mjs",
    "--import",
    preloadPath,
  ]);
  const authIndex = args.indexOf("--auth");
  if (authIndex < 0) {
    throw new Error("Benchmark launch helper did not provide an explicit auth mode");
  }
  args[authIndex + 1] = "token";
  if (reconnectWaves) {
    args.push("--verbose", "--ws-log", "compact");
  }
  if (recovering) {
    restartAt = performance.now();
  }
  const queueClock =
    recovering && values["sqlite-queues"]
      ? {
          OPENCLAW_BENCH_QUEUE_START_NS: String(process.hrtime.bigint()),
          OPENCLAW_BENCH_QUEUE_START_WALL_MS: String(Date.now()),
        }
      : {};
  const child = spawn(process.execPath, args, {
    env: {
      ...env,
      ...queueClock,
      OPENCLAW_BENCH_CAPTURE_DEADLINE_MS: String(Date.now() + Math.min(durationMs, 120_000)),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  childLogs.set(child, log);
  child.once("close", () => log.end());
  let startupOutput = "";
  const observe = (chunk: Buffer) => {
    startupOutput = (startupOutput + chunk.toString()).slice(-4096);
    if (startupOutput.includes("http server listening (")) {
      listeners.add(child);
    }
  };
  child.stdout?.on("data", observe);
  child.stderr?.on("data", observe);
  child.once("error", (error) => {
    failure ??= error;
  });
  child.once("exit", (code, signal) => {
    if (!expectedExits.has(child)) {
      failure ??= new Error(`${name} exited unexpectedly (${code}, ${signal})`);
    }
  });
  child.on("message", (sample: unknown) => {
    if (coldRowReads && recovering && isRecord(sample) && sample.pid === child.pid) {
      if (sample.channel === "cold-rows-ready") {
        coldRowsReady.resolve();
        return;
      }
      if (
        sample.channel === "cold-rows-loop" &&
        typeof sample.samples === "number" &&
        typeof sample.p95Ms === "number" &&
        typeof sample.p99Ms === "number" &&
        typeof sample.maxMs === "number" &&
        typeof sample.mainThreadCpuMs === "number" &&
        typeof sample.processCpuMs === "number" &&
        typeof sample.selectPageCalls === "number" &&
        typeof sample.rowOwnerSha256 === "string" &&
        isRecord(sample.gc) &&
        isRecord(sample.synchronousTasks)
      ) {
        coldRowsLoop.resolve({
          samples: sample.samples,
          p95Ms: sample.p95Ms,
          p99Ms: sample.p99Ms,
          maxMs: sample.maxMs,
          mainThreadCpuMs: sample.mainThreadCpuMs,
          processCpuMs: sample.processCpuMs,
          selectPageCalls: sample.selectPageCalls,
          rowOwnerSha256: sample.rowOwnerSha256,
          gc: sample.gc,
          synchronousTasks: sample.synchronousTasks,
          ...(isRecord(sample.admission) ? { admission: sample.admission } : {}),
        });
        return;
      }
    }
    if (
      recovering &&
      isRecord(sample) &&
      sample.channel === "post-restart-burst-sqlite-queues" &&
      sample.pid === child.pid &&
      isRecord(sample.report)
    ) {
      writeFileSync(
        path.join(output, "sqlite-queues.json"),
        `${JSON.stringify(sample.report, null, 2)}\n`,
      );
      sqliteQueueSnapshot.resolve(sample.report);
      return;
    }
    if (
      recovering &&
      isRecord(sample) &&
      sample.channel === "post-restart-burst-tasks" &&
      sample.pid === child.pid &&
      isRecord(sample.taskCounts)
    ) {
      const counts: Record<string, number> = {};
      for (const [kind, count] of Object.entries(sample.taskCounts)) {
        if (typeof count !== "number") {
          throw new Error("Invalid transcript task count");
        }
        counts[kind] = count;
      }
      transcriptSnapshot.resolve(counts);
      return;
    }
    if (
      recovering &&
      isRecord(sample) &&
      sample.channel === "post-restart-burst-github-fixture" &&
      sample.pid === child.pid
    ) {
      githubFixtureRequests++;
      return;
    }
    if (
      !recovering ||
      !isRecord(sample) ||
      sample.channel !== "post-restart-burst-elu" ||
      sample.pid !== child.pid ||
      typeof sample.intervalMs !== "number" ||
      typeof sample.elu !== "number" ||
      typeof sample.loopDelayMaxMs !== "number" ||
      typeof sample.mainThreadCpuMs !== "number"
    ) {
      return;
    }
    const row = {
      elapsedMs: performance.now() - restartAt,
      intervalMs: sample.intervalMs,
      elu: sample.elu,
      loopDelayMaxMs: sample.loopDelayMaxMs,
      mainThreadCpuMs: sample.mainThreadCpuMs,
    };
    if (reconnectWaves && row.elapsedMs < row.intervalMs) {
      return;
    }
    eluSamples.push(row);
    consecutiveLowSamples =
      performance.now() - sample.intervalMs >= loadStartedAt && sample.elu < 0.8
        ? consecutiveLowSamples + 1
        : 0;
    if (timeToSteadyMs === null && consecutiveLowSamples >= 3) {
      timeToSteadyMs = row.elapsedMs;
    }
    console.log(JSON.stringify({ kind: "elu", ...row }));
  });
  children.push(child);
  gateway = child;
  return child;
}
async function ready(child: ChildProcess) {
  const deadline = performance.now() + 180_000;
  while (performance.now() < deadline) {
    assertAlive();
    if (listeners.has(child)) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          assertAlive();
          return;
        }
      } catch {
        /* Probe retries while the owned listener finishes admission. */
      }
    }
    await delay(100);
  }
  throw new Error(`owned Gateway did not become ready; inspect ${output}`);
}
async function rpc(
  client: ReturnType<typeof createGatewayWsClient>,
  method: string,
  params: unknown,
  timeoutMs = 360_000,
) {
  assertAlive();
  const reply = await client.request(method, params, timeoutMs);
  assertAlive();
  if (!reply.ok) {
    throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  }
  if (values["cheap-handlers"] || values["transcript-reads"]) {
    const payload = reply.payload;
    if (method === "push.web.vapidPublicKey") {
      if (
        !isRecord(payload) ||
        typeof payload.vapidPublicKey !== "string" ||
        !payload.vapidPublicKey ||
        (vapidPublicKey !== undefined && payload.vapidPublicKey !== vapidPublicKey)
      ) {
        throw new Error("VAPID public key missing or changed across restart");
      }
      vapidPublicKey = payload.vapidPublicKey;
    }
    if (
      method === "workboard.cards.list" &&
      (!isRecord(payload) || !Array.isArray(payload.cards) || payload.cards.length < clientCount)
    ) {
      throw new Error("Bundled workboard did not return the seeded cards");
    }
    if (
      method === "chat.history" &&
      (!isRecord(payload) || !Array.isArray(payload.messages) || !payload.messages.length)
    ) {
      throw new Error("Chat history did not return the interrupted synthetic user turn");
    }
    if (method === "tools.invoke" && (!isRecord(payload) || payload.ok !== true)) {
      throw new Error("Synthetic memory search did not activate successfully");
    }
    if (
      method === "github.preview" &&
      (!isRecord(payload) || payload.title !== previewTitle || payload.url !== previewUrl)
    ) {
      throw new Error("Bundled GitHub preview did not return the synthetic transport response");
    }
  }
  if (method === "sessions.catalog.list") {
    const payload = reply.payload;
    if (!isRecord(payload) || !Array.isArray(payload.catalogs)) {
      throw new Error("Synthetic catalog RPC returned no catalogs");
    }
    const catalogs: unknown[] = payload.catalogs;
    const catalog = catalogs.find((item) => isRecord(item) && item.id === catalogId);
    if (!isRecord(catalog) || !Array.isArray(catalog.hosts)) {
      throw new Error("Synthetic metadata catalog is not registered");
    }
    const hosts: unknown[] = catalog.hosts;
    const rows = hosts.reduce<number>(
      (count, host) =>
        count + (isRecord(host) && Array.isArray(host.sessions) ? host.sessions.length : 0),
      0,
    );
    if (!rows) {
      throw new Error("Synthetic metadata catalog returned no rows");
    }
    catalogRowCounts.push(rows);
  }
  return reply.payload;
}
function createSyntheticDevice() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  return {
    id: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
    publicKey,
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}
const devices = new Map<number, ReturnType<typeof createSyntheticDevice>>();
type ConnectAttempt = {
  client: number;
  wave: number;
  startedAtMs: number;
  startedMs: number;
  elapsedMs: number;
  openMs?: number;
  challengeMs?: number;
  connectMs?: number;
  connId?: string;
  presenceRows?: number;
  extensions?: string;
  error?: string;
};
async function connect(index: number, options?: { proxy?: boolean; attempt?: ConnectAttempt }) {
  const startedAt = performance.now();
  let connectStartedAt: number | undefined;
  const attempt = options?.attempt;
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  void challenge.promise.catch(() => {});
  const challengeTimer = setTimeout(
    () => challenge.reject(new Error("Synthetic device challenge timed out")),
    30_000,
  );
  const client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    ...(options?.proxy
      ? {
          headers: {
            "x-forwarded-for": "203.0.113.50",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "gateway.example.test",
          },
        }
      : {}),
    handshakeTimeoutMs: 30_000,
    openTimeoutMs: 30_000,
    onEvent: (event) => {
      const payload = event.payload;
      if (
        event.event === "connect.challenge" &&
        isRecord(payload) &&
        typeof payload.nonce === "string" &&
        typeof payload.ts === "number"
      ) {
        challenge.resolve({ nonce: payload.nonce, ts: payload.ts });
      }
    },
  });
  clients.add(client);
  try {
    await client.waitOpen();
    if (attempt) {
      attempt.openMs = performance.now() - startedAt;
      attempt.extensions = client.ws.extensions;
    }
    if (options?.proxy && !client.ws.extensions.split(",").includes("permessage-deflate")) {
      throw new Error("Synthetic proxy connection did not negotiate permessage-deflate");
    }
    const { nonce, ts } = await challenge.promise;
    if (attempt) {
      attempt.challengeMs = performance.now() - startedAt;
    }
    let device = devices.get(index);
    if (!device) {
      device = createSyntheticDevice();
      devices.set(index, device);
    }
    const scopes = ["operator.read", "operator.write", "operator.admin"];
    const identity = {
      id: "gateway-client",
      displayName: "synthetic-post-restart-burst",
      version: "1.0.0",
      platform: process.platform,
      mode: "ui",
      instanceId: `synthetic-restart-${index}`,
    };
    const payload = buildDeviceAuthPayloadV3({
      deviceId: device.id,
      clientId: identity.id,
      clientMode: identity.mode,
      platform: identity.platform,
      role: "operator",
      scopes,
      signedAtMs: ts,
      token,
      nonce,
    });
    connectStartedAt = performance.now();
    const hello = await rpc(
      client,
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: identity,
        role: "operator",
        scopes,
        auth: { token },
        device: {
          id: device.id,
          publicKey: device.publicKey,
          signedAt: ts,
          nonce,
          signature: signEd25519Payload(device.privateKey, payload),
        },
        caps: [],
      },
      options?.proxy ? 30_000 : undefined,
    );
    if (attempt) {
      attempt.connectMs = performance.now() - connectStartedAt;
    }
    if (
      !isRecord(hello) ||
      !isRecord(hello.auth) ||
      hello.auth.method !== "token" ||
      !Array.isArray(hello.auth.scopes)
    ) {
      throw new Error("Benchmark client did not acquire scoped token/device authentication");
    }
    const authorizedScopes = hello.auth.scopes;
    if (scopes.some((scope) => !authorizedScopes.includes(scope))) {
      throw new Error("Benchmark device authentication did not retain requested operator scopes");
    }
    if (attempt) {
      if (!isRecord(hello.server) || typeof hello.server.connId !== "string") {
        throw new Error("Synthetic connect response did not identify its connection");
      }
      attempt.connId = hello.server.connId;
      if (isRecord(hello.snapshot) && Array.isArray(hello.snapshot.presence)) {
        attempt.presenceRows = hello.snapshot.presence.length;
      }
    }
    // Reconnecting cheap handlers start immediately after auth, without warming a profile read.
    if (
      !options?.proxy &&
      (!recovering || (!coldRowReads && !values["cheap-handlers"] && !values["transcript-reads"]))
    ) {
      const self = await rpc(client, "users.self", {});
      if (
        !isRecord(self) ||
        !isRecord(self.profile) ||
        typeof self.profile.id !== "string" ||
        !self.profile.id
      ) {
        throw new Error("Benchmark client did not acquire the durable synthetic owner profile");
      }
      ownerProfileIds.add(self.profile.id);
    }
    return client;
  } catch (error) {
    if (attempt) {
      attempt.error = String(error);
      if (connectStartedAt !== undefined && attempt.connectMs === undefined) {
        attempt.connectMs = performance.now() - connectStartedAt;
      }
    }
    client.close();
    clients.delete(client);
    throw error;
  } finally {
    if (attempt) {
      attempt.elapsedMs = performance.now() - startedAt;
    }
    clearTimeout(challengeTimer);
  }
}
async function scrapeWriterMetrics(name: string) {
  const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Diagnostic metrics scrape failed: ${response.status}`);
  }
  const metrics = await response.text();
  writeFileSync(path.join(output, `${name}.prom`), metrics);
  const byClass: Record<string, { count: number; waitSeconds: number }> = {};
  for (const line of metrics.split("\n")) {
    const match = /^openclaw_worker_queue_wait_seconds_(sum|count)\{([^}]+)\} ([\d.e+-]+)$/.exec(
      line,
    );
    const labels = match?.[2];
    if (!match || !labels?.includes('kind="sqlite_writer"')) {
      continue;
    }
    const requestClass = /request_class="([^"]+)"/.exec(labels)?.[1];
    if (!requestClass) {
      continue;
    }
    const entry = (byClass[requestClass] ??= { count: 0, waitSeconds: 0 });
    entry[match[1] === "count" ? "count" : "waitSeconds"] = Number(match[3]);
  }
  return { elapsedMs: performance.now() - restartAt, byClass };
}
async function settleWorktreeOperations<T>(operations: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  return results.map((result) => {
    if (result.status === "rejected") {
      throw result.reason;
    }
    return result.value;
  });
}
async function settleArchivedWorktreeCleanup(client: ReturnType<typeof createGatewayWsClient>) {
  const deadline = performance.now() + 60_000;
  let jobId: string | undefined;
  for (let firstPoll = true; performance.now() < deadline; firstPoll = false) {
    // Receipt polls consume the same 30-per-minute control-plane budget as GC requests.
    if (!firstPoll) {
      await delay(2_100);
    }
    if (performance.now() >= deadline) {
      break;
    }
    let receipt: unknown;
    try {
      receipt = await rpc(
        client,
        "worktrees.gc",
        jobId ? { jobId } : {},
        Math.max(1, deadline - performance.now()),
      );
    } catch (error) {
      // Archive notifications can queue a follow-up pass that replaces the latest receipt.
      if (error instanceof Error && error.message.includes("only the latest job is retained")) {
        jobId = undefined;
        continue;
      }
      throw error;
    }
    if (performance.now() >= deadline) {
      break;
    }
    if (!isRecord(receipt) || typeof receipt.jobId !== "string") {
      throw new Error("worktrees.gc did not return a cleanup receipt");
    }
    if (receipt.state === "failed" || receipt.outcome === "partial") {
      throw new Error(`Archive cleanup failed: ${JSON.stringify(receipt)}`);
    }
    if (receipt.state === "completed") {
      return receipt;
    }
    jobId = receipt.jobId;
  }
  throw new Error("Archive cleanup did not settle within 60 seconds");
}
async function measureWorktreeChurn() {
  await delay(Math.max(0, 120_000 - (performance.now() - restartAt)));
  const firstTwoMinutes = await scrapeWriterMetrics("worktree-first-120s");
  const client = await connect(clientCount);
  try {
    const before = await scrapeWriterMetrics("worktree-burst-before");
    const sessions = await settleWorktreeOperations(
      Array.from({ length: 12 }, async (_, index) => {
        const key = `agent:main:worktree-burst-${cohort}-${index}`;
        const created = await rpc(client, "sessions.create", {
          key,
          projectId: worktreeProjectId,
          worktree: true,
          worktreeBaseRef: "main",
          worktreeName: `burst-${index}`,
          visibility: "shared",
          displayName: `Synthetic worktree ${index}`,
        });
        if (
          !isRecord(created) ||
          typeof created.sessionId !== "string" ||
          !isRecord(created.worktree) ||
          typeof created.worktree.id !== "string"
        ) {
          throw new Error("sessions.create did not return an owned worktree");
        }
        return { key, expectedSessionId: created.sessionId };
      }),
    );
    const created = await scrapeWriterMetrics("worktree-burst-created");
    await settleWorktreeOperations(
      sessions.map((session) =>
        rpc(client, "sessions.patch", {
          ...session,
          archived: true,
        }),
      ),
    );
    const archiveCleanup = await settleArchivedWorktreeCleanup(client);
    const archived = await scrapeWriterMetrics("worktree-burst-archived");
    await settleWorktreeOperations(
      sessions.map(async (session) => {
        const deleted = await rpc(client, "sessions.delete", {
          ...session,
          archivedOnly: true,
          deleteTranscript: true,
        });
        if (!isRecord(deleted) || deleted.deleted !== true || deleted.worktreePreserved) {
          throw new Error("sessions.delete did not finish synthetic worktree cleanup");
        }
      }),
    );
    const cleaned = await scrapeWriterMetrics("worktree-burst-cleaned");
    if (
      !Object.entries(cleaned.byClass).some(
        ([requestClass, sample]) =>
          requestClass.startsWith("worktrees.") &&
          sample.count > (before.byClass[requestClass]?.count ?? 0),
      )
    ) {
      throw new Error("Worktree burst produced no per-operation writer queue observations");
    }
    return {
      count: sessions.length,
      firstTwoMinutes,
      before,
      created,
      archived,
      archiveCleanup,
      cleaned,
      boundary:
        "cumulative exporter counts; subtract adjacent snapshots for create/archive/cleanup; concurrent reconnect reads remain included",
    };
  } finally {
    client.close();
    clients.delete(client);
  }
}
const shapes: Array<{ method: string; params: Record<string, unknown> }> = [
  {
    method: "sessions.list",
    params: {
      source: "sidebar",
      rowMode: "sidebar",
      limit: 100,
      includeGlobal: false,
      includeUnknown: false,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      excludeDock: true,
      configuredAgentsOnly: true,
      sortBy: "lastInteractionAt",
      archived: false,
    },
  },
  { method: "sessions.catalog.list", params: { catalogId, agentId: "main", limitPerHost: 100 } },
  { method: "projects.list", params: {} },
];
const timings: Array<{
  method: string;
  startedMs: number;
  elapsedMs: number;
  error?: string;
  client?: number;
  wave?: number;
}> = [];
const connectionErrors: Array<{ client: number; elapsedMs: number; error: string }> = [];
const connectedClients = new Set<number>();
const ownerProfileIds = new Set<string>();
const catalogRowCounts: number[] = [];
const subscriptionParams = (index: number) => ({
  endpoint: `https://push.example.test/post-restart/${cohort}/${index}`,
  keys: { p256dh: "synthetic-browser-p256dh", auth: "synthetic-browser-auth" },
});
async function observeClient(index: number) {
  const deadline = restartAt + durationMs;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let firstBatch = true;
  while (performance.now() < deadline) {
    assertAlive();
    if (!client) {
      try {
        client = await connect(index);
        connectedClients.add(index);
        firstBatch = true;
      } catch (error) {
        assertAlive();
        connectionErrors.push({
          client: index,
          elapsedMs: performance.now() - restartAt,
          error: String(error),
        });
        await delay(1000);
        continue;
      }
    }
    const activeClient = client;
    await Promise.all(
      shapes
        .filter(({ method }) =>
          method === "tools.invoke"
            ? firstBatch && index === 0
            : method !== "sessions.subscribe" || firstBatch,
        )
        .map(async ({ method, params }) => {
          const startedMs = performance.now() - restartAt;
          try {
            await rpc(
              activeClient,
              method,
              method === "push.web.subscribe" ? subscriptionParams(index) : params,
            );
            timings.push({
              method,
              startedMs,
              elapsedMs: performance.now() - restartAt - startedMs,
            });
          } catch (error) {
            assertAlive();
            timings.push({
              method,
              startedMs,
              elapsedMs: performance.now() - restartAt - startedMs,
              error: String(error),
            });
          }
        }),
    );
    firstBatch = false;
    if (client.ws.readyState !== client.ws.OPEN) {
      client.close();
      clients.delete(client);
      client = undefined;
    }
    await delay(Math.max(0, Math.min(pollMs, deadline - performance.now())));
  }
}
function summarize(rows: typeof timings) {
  const successful = rows
    .filter((row) => row.error === undefined)
    .map((row) => row.elapsedMs)
    .toSorted((a, b) => a - b);
  const percentile = (fraction: number) =>
    successful[Math.max(0, Math.ceil(successful.length * fraction) - 1)] ?? null;
  return {
    started: rows.length,
    completed: successful.length,
    errors: rows.length - successful.length,
    p50Ms: percentile(0.5),
    p90Ms: percentile(0.9),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: successful.at(-1) ?? null,
  };
}
async function closeMeasuredClient(client: ReturnType<typeof createGatewayWsClient>) {
  if (client.ws.readyState !== client.ws.CLOSED) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.ws.terminate();
        reject(new Error("Synthetic reconnect socket did not close"));
      }, 10_000);
      client.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      client.close();
    });
  }
  clients.delete(client);
}
async function measureReconnectWaves(initialClients: Awaited<ReturnType<typeof connect>>[]) {
  const active = [...initialClients];
  const clientIndices = Array.from({ length: clientCount }, (_, index) => index);
  const attempts: ConnectAttempt[] = [];
  async function replace(indices: number[], wave?: number) {
    const closed = await Promise.allSettled(
      indices.map((index) => closeMeasuredClient(active[index]!)),
    );
    const closeFailures = closed.filter((result) => result.status === "rejected");
    if (closeFailures.length) {
      throw new AggregateError(
        closeFailures.map((result) => result.reason),
        "Reconnect close failed",
      );
    }
    const connected = await Promise.allSettled(
      indices.map(async (index) => {
        const attempt: ConnectAttempt | undefined =
          wave === undefined
            ? undefined
            : {
                client: index,
                wave,
                startedAtMs: Date.now(),
                startedMs: performance.now() - restartAt,
                elapsedMs: 0,
              };
        if (attempt) {
          attempts.push(attempt);
        }
        active[index] = await connect(index, { proxy: true, attempt });
      }),
    );
    const connectFailures = connected.filter((result) => result.status === "rejected");
    if (connectFailures.length) {
      throw new AggregateError(
        connectFailures.map((result) => result.reason),
        "Reconnect attempt failed",
      );
    }
  }
  async function listBatch(index: number, wave?: number) {
    await Promise.all(
      shapes.map(async ({ method, params }) => {
        const startedMs = performance.now() - restartAt;
        let error: string | undefined;
        try {
          await rpc(active[index]!, method, params, 30_000);
        } catch (cause) {
          error = String(cause);
        }
        if (wave !== undefined) {
          timings.push({
            method,
            client: index,
            wave,
            startedMs,
            elapsedMs: performance.now() - restartAt - startedMs,
            ...(error ? { error } : {}),
          });
        } else if (error) {
          throw new Error(error);
        }
      }),
    );
  }
  // Pair locally once, then warm every device through the same attributed ingress as measurement.
  for (let offset = 0; offset < clientCount; offset += 32) {
    await replace(clientIndices.slice(offset, offset + 32));
  }
  await Promise.all(active.map((_client, index) => listBatch(index)));
  console.log(
    `PHASE reconnect-ready clients=${active.length} reconnecting=${reconnectCount} waves=${waveCount}`,
  );
  if (measurementStartAt !== undefined) {
    if (Date.now() > measurementStartAt) {
      throw new Error("Reconnect setup missed --start-at; choose a later paired start time");
    }
    await delay(measurementStartAt - Date.now());
  }
  recovering = true;
  restartAt = performance.now();
  loadStartedAt = restartAt;
  const measuredStartedAtMs = Date.now();
  let measurementError: string | undefined;
  let completedWaves = 0;
  for (let wave = 0; wave < waveCount; wave++) {
    const waveStartedAt = performance.now();
    const rotated = clientIndices.map((offset) => (wave * reconnectCount + offset) % clientCount);
    const stop = Promise.withResolvers<void>();
    let finished = false;
    const polling = Promise.all(
      rotated.slice(reconnectCount).map(async (index) => {
        for (;;) {
          await listBatch(index, wave);
          await Promise.race([delay(pollMs, undefined, { ref: false }), stop.promise]);
          if (finished) {
            return;
          }
        }
      }),
    );
    try {
      await replace(rotated.slice(0, reconnectCount), wave);
      await delay(Math.max(0, pollMs - (performance.now() - waveStartedAt)));
      assertAlive();
      completedWaves++;
    } catch (error) {
      measurementError = String(error);
    } finally {
      finished = true;
      stop.resolve();
      await polling;
    }
    if (measurementError) {
      break;
    }
  }
  const connectTimings = attempts.map((attempt) => ({
    method: "connect",
    startedMs: attempt.startedMs,
    elapsedMs: attempt.connectMs ?? attempt.elapsedMs,
    ...(attempt.error ? { error: attempt.error } : {}),
  }));
  const result = {
    output,
    fixture,
    mode: "warm-reconnect-waves",
    clientCount,
    reconnectCount,
    pollingClientCount: clientCount - reconnectCount,
    waveCount,
    expectedAttempts: waveCount * reconnectCount,
    completedWaves,
    pollMs,
    measurementStartAt,
    measuredStartedAtMs,
    durationMs: performance.now() - restartAt,
    transport:
      "loopback trusted proxy attribution; signed paired devices; permessage-deflate negotiated; hello uncompressed",
    phaseLog: path.join(output, "gateway-reconnect.log"),
    connectionTiming:
      "connectMs measures the connect RPC through hello, excluding users.self; elapsedMs includes socket open and challenge",
    connect: summarize(connectTimings),
    requests: Object.fromEntries(
      shapes.map(({ method }) => [
        method,
        summarize(timings.filter((row) => row.method === method)),
      ]),
    ),
    attempts,
    timings,
    eluSamples,
    ...(measurementError ? { error: measurementError } : {}),
  };
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { ...result, attempts: undefined, timings: undefined, eluSamples: undefined },
      null,
      2,
    ),
  );
  if (
    measurementError ||
    completedWaves !== waveCount ||
    attempts.some((row) => row.error) ||
    timings.some((row) => row.error)
  ) {
    throw new Error(`incomplete reconnect measurement; inspect ${output}/result.json`);
  }
}
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    closing = true;
    for (const child of children) {
      expectedExits.add(child);
    }
    for (const client of clients) {
      client.close();
    }
    const cleanupErrors: unknown[] = [];
    try {
      const results = await Promise.allSettled(
        children.map(async (child) => {
          const stopped = await stopChild(child, { teardownGraceMs: 10_000, killGraceMs: 2000 });
          const group = inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" });
          if (
            (child.exitCode === null && child.signalCode === null) ||
            (stopped.exitCode === null && stopped.signal === null) ||
            group !== "dead"
          ) {
            throw new Error(
              `owned Gateway cleanup unresolved: ${JSON.stringify({ pid: child.pid, stopped, exitCode: child.exitCode, signal: child.signalCode, group })}`,
            );
          }
        }),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          cleanupErrors.push(result.reason);
        }
      }
    } finally {
      try {
        mock.closeAllConnections();
        if (mock.listening) {
          await new Promise<void>((resolve, reject) => {
            mock.close((error) => (error ? reject(error) : resolve()));
          });
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        cleanupErrors,
        "Benchmark cleanup could not settle all owned resources",
      );
    }
  })());
}
for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    void cleanup().then(
      () => process.exit(exitCode),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
try {
  await assertPortAvailable(port);
  if (!reconnectWaves && !coldRowReads) {
    await assertPortAvailable(mockPort);
    await new Promise<void>((resolve, reject) => {
      mock.once("error", reject);
      mock.listen(mockPort, "127.0.0.1", resolve);
    });
  }
  const initial = launch(reconnectWaves ? "gateway-reconnect" : "gateway-before-crash");
  await ready(initial);
  const initialClients: Awaited<ReturnType<typeof connect>>[] = [];
  // Pair devices before the measured restart without exhausting the per-IP preauth budget.
  for (let offset = 0; offset < clientCount; offset += 32) {
    initialClients.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(32, clientCount - offset) }, (_, index) =>
          connect(offset + index),
        ),
      )),
    );
  }
  if (coldRowReads) {
    await measureColdRowReads(initial, initialClients);
  } else if (reconnectWaves) {
    await measureReconnectWaves(initialClients);
  } else {
    await measureRestartBurst(initial, initialClients);
  }
} finally {
  if (!closing) {
    await cleanup();
  }
}
async function measureColdRowReads(
  initial: ChildProcess,
  initialClients: Awaited<ReturnType<typeof connect>>[],
) {
  const sender = initialClients[0];
  if (!sender) {
    throw new Error("No synthetic sender connected");
  }
  const sessionKey = "agent:main:team-shape-session-1";
  for (let index = 0; index < 3; index++) {
    await rpc(sender, "board.widget.put", {
      sessionKey,
      name: `synthetic-cold-row-${index}`,
      content: { kind: "html", html: `<p>Synthetic cold row ${index}</p>` },
    });
  }
  for (const client of initialClients) {
    await closeMeasuredClient(client);
  }
  expectedExits.add(initial);
  await stopChild(initial, { teardownGraceMs: 30_000, killGraceMs: 2000 });
  if (inspectManagedProcessGroup(initial, { errorPolicy: "indeterminate" }) !== "dead") {
    throw new Error("Initial Gateway process group did not stop before the cold restart");
  }
  console.log(`PHASE cold-row-restart-prepared output=${output}`);
  if (measurementStartAt !== undefined) {
    const remaining = measurementStartAt - Date.now();
    if (remaining < 0) {
      throw new Error("--start-at deadline passed before cold restart preparation finished");
    }
    await delay(remaining);
  }
  recovering = true;
  await assertPortAvailable(port);
  const startedAtEpochMs = Date.now();
  const restarted = launch("gateway-cold-rows");
  await ready(restarted);
  const readyMs = performance.now() - restartAt;
  loadStartedAt = performance.now();
  restarted.send({ channel: "cold-rows-ready" });
  await Promise.race([
    coldRowsReady.promise,
    delay(10_000, undefined, { ref: false }).then(() => {
      throw new Error("Cold row probe did not start");
    }),
  ]);
  const makeReadShapes = (clientSessionKey: string) => [
    ...(startupAdmission
      ? [
          {
            name: "models.list",
            method: "models.list",
            params: { agentId: "main", sessionKey: clientSessionKey, view: "configured" },
          },
          {
            name: "sessions.subscribe",
            method: "sessions.subscribe",
            params: { includeMessageBodies: false },
          },
        ]
      : []),
    { name: "sessions.list:sidebar", method: "sessions.list", params: shapes[0]!.params },
    {
      name: "sessions.list:agent-roster",
      method: "sessions.list",
      params: {
        source: "agent-roster",
        rowMode: "sidebar",
        limit: 100,
        archived: "all",
        excludeDock: true,
        includeDerivedTitles: true,
        includeLastMessage: true,
      },
    },
    { name: "board.get", method: "board.get", params: { sessionKey } },
    ...(startupAdmission
      ? [
          {
            name: "sessions.resolve",
            method: "sessions.resolve",
            params: { key: clientSessionKey },
          },
          {
            name: "sessions.messages.subscribe",
            method: "sessions.messages.subscribe",
            params: { key: clientSessionKey },
          },
          {
            name: "chat.startup",
            method: "chat.startup",
            params: { sessionKey: clientSessionKey, limit: 40, maxBytes: 262144 },
          },
        ]
      : []),
  ];
  // The fixture's indices ending in 1 are shared and unarchived.
  const clientSessionKeys = Array.from({ length: clientCount }, (_, index) =>
    startupAdmission ? `agent:main:team-shape-session-${1 + 10 * index}` : sessionKey,
  );
  const clientReadShapes = clientSessionKeys.map(makeReadShapes);
  const readShapes = clientReadShapes[0]!;
  const deadline = loadStartedAt + durationMs;
  console.log(`PHASE cold-row-ready ${readyMs.toFixed(1)}ms`);
  const observations = await Promise.allSettled(
    Array.from({ length: clientCount }, async (_, index) => {
      const client = await connect(index);
      const clientSessionKey = clientSessionKeys[index]!;
      connectedClients.add(index);
      for (
        let wave = 0;
        startupAdmission ? wave < waveCount : performance.now() < deadline;
        wave++
      ) {
        await Promise.all(
          clientReadShapes[index]!.map(async ({ name, method, params }) => {
            const startedMs = performance.now() - restartAt;
            let error: string | undefined;
            try {
              const response = await rpc(client, method, params);
              if (method === "board.get") {
                if (
                  !isRecord(response) ||
                  !Array.isArray(response.widgets) ||
                  response.widgets.length !== 3
                ) {
                  throw new Error("Board did not return all three seeded widgets");
                }
              } else if (method === "models.list") {
                if (!isRecord(response) || !Array.isArray(response.models)) {
                  throw new Error("Model catalog did not return its models array");
                }
              } else if (method === "sessions.resolve") {
                if (
                  !isRecord(response) ||
                  response.ok !== true ||
                  response.key !== clientSessionKey
                ) {
                  throw new Error("Session resolution did not return the seeded session");
                }
              } else if (method === "sessions.messages.subscribe") {
                if (
                  !isRecord(response) ||
                  response.subscribed !== true ||
                  response.key !== clientSessionKey
                ) {
                  throw new Error("Message subscription did not admit the seeded session");
                }
              } else if (method === "chat.startup") {
                if (
                  !isRecord(response) ||
                  response.sessionKey !== clientSessionKey ||
                  !Array.isArray(response.messages) ||
                  !isRecord(response.sessionInfo)
                ) {
                  throw new Error(
                    "Chat startup did not return the seeded session and history page",
                  );
                }
              } else if (method === "sessions.subscribe") {
                if (!isRecord(response) || response.subscribed !== true) {
                  throw new Error("Session subscription did not enroll its observer");
                }
              } else if (
                !isRecord(response) ||
                !Array.isArray(response.sessions) ||
                !response.sessions.some(
                  (row: unknown) =>
                    isRecord(row) &&
                    typeof row.key === "string" &&
                    row.key.startsWith("agent:main:team-shape-session-"),
                )
              ) {
                throw new Error("Session list did not return the seeded roster");
              }
            } catch (cause) {
              error = String(cause);
            }
            timings.push({
              method: name,
              client: index,
              wave,
              startedMs,
              elapsedMs: performance.now() - restartAt - startedMs,
              ...(error ? { error } : {}),
            });
          }),
        );
        await delay(
          startupAdmission ? pollMs : Math.max(0, Math.min(pollMs, deadline - performance.now())),
        );
      }
    }),
  );
  assertAlive();
  // Successful socket replies precede the dispatch-finally diagnostic publication.
  if (startupAdmission) {
    await delay(0);
  }
  restarted.send({ channel: "cold-rows-finish" });
  const {
    mainThreadCpuMs,
    processCpuMs,
    selectPageCalls,
    rowOwnerSha256,
    gc,
    synchronousTasks,
    admission,
    ...loop
  } = await Promise.race([
    coldRowsLoop.promise,
    delay(10_000, undefined, { ref: false }).then(() => {
      throw new Error("Cold row probe did not finish");
    }),
  ]);
  const errors = observations.flatMap((observation) =>
    observation.status === "rejected" ? [String(observation.reason)] : [],
  );
  const afterReadyDurationMs = performance.now() - loadStartedAt;
  let promotion: ReturnType<typeof readGatewayGcTrace> | undefined;
  if (values["trace-gc"]) {
    await cleanup();
    await Promise.all([...childLogs.values()].map((log) => streamFinished(log)));
    promotion = readGatewayGcTrace(
      path.join(output, "gateway-cold-rows.log"),
      "cold-rows",
      "diagnostics",
    );
  }
  const completedReads = timings.filter((row) => !row.error).length;
  const result = {
    output,
    fixture,
    scenario: startupAdmission ? "startup-admission" : "cold-row-reads",
    clientCount,
    ...(startupAdmission
      ? {
          waves: waveCount,
          pollMs,
          clientSessionKeys,
          admission,
          requestStartOwner: { path: requestStartOwner, sha256: requestStartOwnerSha256 },
        }
      : {}),
    readyMs,
    startedAtEpochMs,
    afterReadyDurationMs,
    loop,
    synchronousTasks,
    mainThreadCpuMs,
    processCpuMs,
    selectPageCalls,
    rowRefreshOwner: { path: rowRefreshOwner, sha256: rowOwnerSha256 },
    gc,
    promotion,
    promotedBytesPerRead:
      promotion && completedReads ? promotion.promotedBytes / completedReads : null,
    connectedClients: connectedClients.size,
    ...(startupAdmission ? { completedRequests: completedReads } : {}),
    errors,
    reads: Object.fromEntries(
      readShapes.map(({ name, params }, shapeIndex) => [
        name,
        {
          ...(startupAdmission
            ? {
                paramsByClient: clientReadShapes.map(
                  (clientShapes) => clientShapes[shapeIndex]!.params,
                ),
              }
            : { params }),
          ...summarize(timings.filter((row) => row.method === name)),
          firstBatch: summarize(timings.filter((row) => row.method === name && row.wave === 0)),
        },
      ]),
    ),
    timings,
    eluSamples,
  };
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, timings: undefined, eluSamples: undefined }, null, 2));
  if (
    errors.length ||
    connectedClients.size !== clientCount ||
    loop.samples === 0 ||
    timings.some((row) => row.error) ||
    readShapes.some(
      ({ name }) =>
        timings.filter((row) => row.method === name && row.wave === 0).length !== clientCount,
    )
  ) {
    throw new Error(`Incomplete cold row measurement; inspect ${output}/result.json`);
  }
}
async function measureRestartBurst(
  initial: ChildProcess,
  initialClients: Awaited<ReturnType<typeof connect>>[],
) {
  const sender = initialClients[0];
  if (!sender) {
    throw new Error("No synthetic sender connected");
  }
  const keys = Array.from(
    { length: runCount },
    (_, index) => `agent:main:post-restart-${cohort}-${index + 1}`,
  );
  for (const key of keys) {
    await rpc(sender, "sessions.create", {
      key,
      visibility: "shared",
      displayName: "Synthetic interrupted restart run",
    });
  }
  if (values["writer-reads"] || values["cheap-handlers"]) {
    shapes.push({ method: "sessions.github.options", params: { sessionKey: keys[0] } });
  }
  if (values["writer-reads"]) {
    shapes.push({ method: "agents.list", params: {} });
  }
  if (values["cheap-handlers"]) {
    // The UI registers this observer before its reconnect roster bootstrap.
    shapes.unshift({ method: "sessions.subscribe", params: {} });
    await rpc(sender, "push.web.vapidPublicKey", {});
    for (const [index, client] of initialClients.entries()) {
      const params = subscriptionParams(index);
      await rpc(client, "push.web.subscribe", params);
      await rpc(client, "push.web.preferences.set", {
        endpoint: params.endpoint,
        scope: "device",
        preferences: { enabled: false, label: "Synthetic restart browser" },
      });
      await rpc(sender, "workboard.cards.create", { title: `Synthetic restart card ${index}` });
    }
    shapes.push(
      { method: "push.web.vapidPublicKey", params: {} },
      { method: "push.web.subscribe", params: { endpoint: "one synthetic endpoint per device" } },
      { method: "workboard.cards.list", params: {} },
      { method: "github.preview", params: { url: previewUrl } },
    );
    // Prove both bundled plugins are usable before measuring their cold restart.
    await rpc(sender, "workboard.cards.list", {});
    await rpc(sender, "github.preview", { url: previewUrl });
  }
  if (values["transcript-reads"]) {
    if (!values["cheap-handlers"]) {
      shapes.unshift({ method: "sessions.subscribe", params: {} });
      for (let index = 0; index < clientCount; index++) {
        await rpc(sender, "workboard.cards.create", { title: `Synthetic restart card ${index}` });
      }
      shapes.push({ method: "workboard.cards.list", params: {} });
    }
    shapes.push(
      { method: "chat.history", params: { sessionKey: keys[0], limit: 50 } },
      {
        method: "tools.invoke",
        params: {
          sessionKey: keys[0],
          name: "memory_search",
          args: { query: "synthetic fixture", maxResults: 1 },
        },
      },
    );
  }
  const runIds = keys.map(() => randomUUID());
  await Promise.all(
    keys.map((sessionKey, index) =>
      rpc(sender, "agent", {
        sessionKey,
        message: message(index + 1),
        deliver: false,
        idempotencyKey: runIds[index],
      }),
    ),
  );
  const arrivalDeadline = performance.now() + 180_000;
  while (initialArrivals.size !== runCount) {
    assertAlive();
    if (performance.now() >= arrivalDeadline) {
      throw new Error(
        `only ${initialArrivals.size}/${runCount} uniquely marked primary requests arrived`,
      );
    }
    await delay(25);
  }
  assertAlive();
  if (
    heldResponses.size !== runCount ||
    [...heldResponses.values()].some((response) => response.destroyed || response.writableEnded)
  ) {
    throw new Error(
      `only ${heldResponses.size}/${runCount} primary responses remain held at crash`,
    );
  }
  activePrimaryHoldsAtCrash = heldResponses.size;
  console.log(`PHASE crash ${activePrimaryHoldsAtCrash} held primary requests`);
  expectedExits.add(initial);
  const crashed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("owned Gateway did not exit after SIGKILL")),
      10_000,
    );
    initial.once("close", (_code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") {
        resolve();
      } else {
        reject(new Error(`unexpected crash signal ${signal}`));
      }
    });
  });
  crashExpected = true;
  terminateManagedChild(initial, "SIGKILL", {
    onChildSignalError(error) {
      throw error;
    },
  });
  await crashed;
  for (const client of initialClients) {
    client.close();
    clients.delete(client);
  }
  const drainDeadline = performance.now() + 10_000;
  while (heldResponses.size) {
    if (performance.now() >= drainDeadline) {
      throw new Error(
        `${heldResponses.size} initial primary model responses did not close after SIGKILL`,
      );
    }
    await delay(10);
  }
  // Initial held-response close callbacks have drained before allowing quick recovery answers.
  recovering = true;
  if (values["transcript-reads"]) {
    // Keep the corpus unindexed during setup so the measured restart owns cold catch-up.
    cfg.memory.search = {
      enabled: true,
      provider: "none",
      sources: ["sessions"],
      experimental: { sessionMemory: true },
    };
    writeFileSync(configPath, JSON.stringify(cfg));
  }
  await assertPortAvailable(port);
  const restarted = launch("gateway-after-restart");
  const sqliteQueueMetrics = values["sqlite-queues"]
    ? Promise.race([
        sqliteQueueSnapshot.promise,
        delay(durationMs + 30_000, undefined, { ref: false }).then(() => {
          throw new Error("SQLite queue snapshot timed out");
        }),
      ])
    : Promise.resolve(undefined);
  void sqliteQueueMetrics.catch((error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  });
  await ready(restarted);
  const readyMs = performance.now() - restartAt;
  console.log(`PHASE restarted-ready ${readyMs.toFixed(1)}ms`);
  loadStartedAt = performance.now();
  const transcriptMetrics = delay(
    Math.max(0, Math.min(durationMs, 120_000) - (performance.now() - restartAt)),
  ).then(async () => {
    restarted.send({ channel: "post-restart-burst-snapshot" });
    return await Promise.race([
      transcriptSnapshot.promise,
      delay(10_000, undefined, { ref: false }).then(() => {
        throw new Error("Transcript task snapshot timed out");
      }),
    ]);
  });
  void transcriptMetrics.catch((error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  });
  const diagnosticMetrics =
    values["writer-reads"] || values["cheap-handlers"] || values["transcript-reads"]
      ? delay(
          Math.max(0, Math.min(durationMs, 300_000) - (performance.now() - restartAt)),
          undefined,
          { ref: false },
        ).then(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            throw new Error(`Diagnostic metrics scrape failed: ${response.status}`);
          }
          const metrics = await response.text();
          writeFileSync(path.join(output, "writer-metrics.prom"), metrics);
          return metrics.split("\n");
        })
      : Promise.resolve(undefined);
  // Observe a failed scrape immediately while the reconnect cohort is still running.
  void diagnosticMetrics.catch((error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  });
  const [worktreeChurn] = await Promise.all([
    values["worktree-churn"] ? measureWorktreeChurn() : Promise.resolve(undefined),
    Promise.all(Array.from({ length: clientCount }, (_, index) => observeClient(index))),
  ]);
  assertAlive();
  const metrics = await diagnosticMetrics;
  const transcriptTaskCounts = await transcriptMetrics;
  const sqliteQueues = await sqliteQueueMetrics;
  const result = {
    output,
    fixture,
    clientCount,
    runCount,
    durationMs,
    pollMs,
    sqliteQueues,
    worktreeChurn,
    nativeTaskInputs: {
      windowMs: Math.min(durationMs, 120_000),
      counts: transcriptTaskCounts,
      total: Object.values(transcriptTaskCounts).reduce((sum, count) => sum + count, 0),
      boundary:
        "main-isolate native task submissions across all workers; bounded input kind and history request kind only",
      memory: values["transcript-reads"]
        ? "cold sessions-only FTS index enabled at measured restart"
        : "disabled",
    },
    transcriptQueueMetrics: metrics?.filter(
      (line) =>
        /^openclaw_worker_queue_wait_seconds_(sum|count)\{/.test(line) &&
        line.includes('kind="sessionTranscript"'),
    ),
    writerQueueMetrics: metrics?.filter(
      (line) =>
        /^openclaw_worker_queue_wait_seconds_(sum|count)\{/.test(line) &&
        line.includes('kind="sqlite_writer"'),
    ),
    rpcPhaseMetrics: metrics?.filter((line) =>
      /^openclaw_gateway_rpc_(admission|handler|first_response|queue_wait)_seconds_/.test(line),
    ),
    cheapHandlerFixture: values["cheap-handlers"]
      ? {
          githubFixtureRequests,
          github:
            "bundled plugin and host dispatch; anonymous identity; fixed in-process HTTP transport; no external GitHub latency",
          workboardCards: clientCount,
          push: "persisted VAPID key and one disabled subscription per paired browser",
          reconnectOrder:
            "sessions.subscribe starts first on each socket, before parallel list and cheap-handler requests",
          diagnostics:
            "cumulative histograms since exporter start; requests before exporter subscription are not covered",
        }
      : undefined,
    readyMs,
    initialPrimaryArrivals: initialArrivals.size,
    activePrimaryHoldsAtCrash,
    recoveryPrimaryArrivals: recoveryArrivals.size,
    ownerProfileIds: [...ownerProfileIds],
    catalogFixture:
      "synthetic provider consumes Gateway sessionEntries metadata; no real provider scan or network latency",
    catalogRows: { min: Math.min(...catalogRowCounts), max: Math.max(...catalogRowCounts) },
    connectedClients: connectedClients.size,
    timeToSteadyMs,
    steadyDefinition:
      "first three consecutive 5-second ELU samples fully after reconnect load began and below 0.8, measured from restart spawn; null means not observed",
    firstFiveMinutes: Object.fromEntries(
      shapes.map(({ method, params }) => [
        method,
        {
          params,
          ...summarize(timings.filter((row) => row.method === method && row.startedMs < 300_000)),
        },
      ]),
    ),
    firstTwoMinutesMainElu: (() => {
      const samples = eluSamples.filter(
        (sample) => sample.elapsedMs <= Math.min(durationMs, 120_000),
      );
      const observedMs = samples.reduce((sum, sample) => sum + sample.intervalMs, 0);
      return {
        samples: samples.length,
        observedMs,
        weightedMean: observedMs
          ? samples.reduce((sum, sample) => sum + sample.elu * sample.intervalMs, 0) / observedMs
          : null,
        max: samples.length ? Math.max(...samples.map((sample) => sample.elu)) : null,
      };
    })(),
    firstTwoMinutes: Object.fromEntries(
      shapes.map(({ method, params }) => [
        method,
        {
          params,
          ...summarize(timings.filter((row) => row.method === method && row.startedMs < 120_000)),
        },
      ]),
    ),
    connectionErrors,
    timings,
    eluSamples,
  };
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        ...result,
        timings: undefined,
        eluSamples: undefined,
        sqliteQueues: sqliteQueues
          ? {
              complete: sqliteQueues.complete,
              events: sqliteQueues.events,
              file: "sqlite-queues.json",
            }
          : undefined,
      },
      null,
      2,
    ),
  );
  if (
    connectedClients.size < clientCount ||
    shapes.some(({ method }) => !timings.some((row) => row.method === method && !row.error)) ||
    (values["cheap-handlers"] && githubFixtureRequests === 0) ||
    (sqliteQueues && sqliteQueues.complete !== true) ||
    eluSamples.length === 0
  ) {
    throw new Error(`incomplete measurement; inspect ${output}/result.json`);
  }
}
