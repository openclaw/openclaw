// Own synthetic state only. Run with node --import ./scripts/tsx.mjs.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
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
    clients: { type: "string", default: "50" },
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
const clientCount = integer(values.clients, "--clients");
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
applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
cfg.agents.defaults = { ...cfg.agents.defaults, maxConcurrent: runCount, skipBootstrap: true };
cfg.memory = { ...cfg.memory, search: { enabled: false } };
cfg.tools = { codeMode: false };
cfg.plugins = {
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
cfg.plugins.load = { ...cfg.plugins.load, paths: [...(cfg.plugins.load?.paths ?? []), pluginDir] };
cfg.plugins.entries = { ...cfg.plugins.entries, [catalogId]: { enabled: true } };
const configPath = path.join(output, "openclaw.json");
writeFileSync(configPath, JSON.stringify(cfg));
// Private IPC only, no inspector listener or product RPC. Deltas include startup and recovery.
const preloadPath = path.join(output, "elu-preload.mjs");
writeFileSync(
  preloadPath,
  `import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { isMainThread, MessagePort } from 'node:worker_threads';
if (isMainThread) {
  if (!process.send) throw new Error('Benchmark requires private IPC');
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
  OPENAI_API_KEY: "synthetic-fixture",
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
async function connect(index: number) {
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  void challenge.promise.catch(() => {});
  const challengeTimer = setTimeout(
    () => challenge.reject(new Error("Synthetic device challenge timed out")),
    30_000,
  );
  const client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
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
    const { nonce, ts } = await challenge.promise;
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
    const hello = await rpc(client, "connect", {
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
    });
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
    // Reconnecting cheap handlers start immediately after auth, without warming a profile read.
    if (!recovering || (!values["cheap-handlers"] && !values["transcript-reads"])) {
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
    client.close();
    clients.delete(client);
    throw error;
  } finally {
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
const timings: Array<{ method: string; startedMs: number; elapsedMs: number; error?: string }> = [];
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
  await assertPortAvailable(mockPort);
  await new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(mockPort, "127.0.0.1", resolve);
  });
  const initial = launch("gateway-before-crash");
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
  const summarize = (rows: typeof timings) => {
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
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: successful.at(-1) ?? null,
    };
  };
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
} finally {
  if (!closing) {
    await cleanup();
  }
}
