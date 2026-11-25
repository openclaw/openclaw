/**
 * Synthetic initial-history subscription benchmark, using the selected revision's
 * real Gateway request handler, history readers, SQLite owners, and cold archive.
 * Run one fresh process per arm from the selected revision root so TypeScript
 * aliases resolve within that revision. Roots need installed dependencies and
 * their normal worker/runtime build prerequisites; the script may live elsewhere:
 *
 * cd /path/to/base
 * node --import ./scripts/tsx.mjs /path/to/tooling/scripts/perf/session-cold-subscribe.mjs \
 *   --mode busy --iterations 32 > base-busy.jsonl
 * Repeat from the candidate root; repeat hot, cold, and busy with --allocation
 * for separate inspector passes. No live Gateway, operator state, or model calls.
 *
 * Each operation selects an independent 256-message transcript prepared outside
 * measurement. busy holds the writer for 1,000 ms; hot/cold leave it available.
 * CPU includes worker threads; mainThreadCpuMs records the calling thread separately.
 * Allocation samples only the main isolate, including
 * collected objects, at 16 KiB. Traced timings are not latency evidence. p99 with
 * fewer than 1,000 observations is context only. State is private and cleaned up.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "cold" },
    iterations: { type: "string", default: "32" },
    allocation: { type: "boolean", default: false },
  },
});
const mode = values.mode;
const count = Number(values.iterations);
const instrumentation = values.allocation ? "allocation" : "timing";
assert(["hot", "cold", "busy"].includes(mode));
assert(Number.isSafeInteger(count) && count > 0 && count <= 1000);
const root = process.cwd();
const imp = (name) => import(pathToFileURL(path.join(root, name.replace(/\.js$/u, ".ts"))).href);
const { createOpenClawTestState } = await imp("src/test-utils/openclaw-test-state.js");
const { setRuntimeConfigSnapshot } = await imp("src/config/runtime-snapshot.js");
const { replaceSessionEntrySync } = await imp("src/config/sessions/session-accessor.js");
const { resolveSqliteTranscriptScope } = await imp(
  "src/config/sessions/session-accessor.sqlite-scope.js",
);
const { replaceSqliteTranscriptEventsInTransaction } = await imp(
  "src/config/sessions/session-accessor.sqlite-transcript-store.js",
);
const { runOpenClawAgentWriteTransaction, openOpenClawAgentDatabase } = await imp(
  "src/state/openclaw-agent-db.js",
);
const { waitForSessionTranscriptIndexReconcilesInStateDir } = await imp(
  "src/config/sessions/session-transcript-reconcile.js",
);
const { runSessionColdStorageMaintenance } = await imp(
  "src/config/sessions/session-cold-storage.js",
);
const { readSessionColdTranscript } = await imp(
  "src/config/sessions/session-cold-storage-state.js",
);
const { CURRENT_SESSION_VERSION } = await imp("src/config/sessions/version.js");
const { runOpenClawAgentWriteAdmission } = await imp("src/state/openclaw-agent-write-admission.js");
const { createDeferredCore } = await imp("src/shared/deferred.js");
const { createSessionMessageSubscriberRegistry, createChatRunState } = await imp(
  "src/gateway/server-chat-state.js",
);
const { createSessionRowProjection } = await imp("src/gateway/session-row-projection.js");
const { bindSessionRowProjection } = await imp("src/gateway/session-row-projection-access.js");
const { handleGatewayRequest } = await imp("src/gateway/server-methods.js");
const { sessionSubscriptionHandlers } = await imp(
  "src/gateway/server-methods/sessions-subscriptions.js",
);
const { trackAsyncWork } = await imp("src/shared/async-work-scope.js");
const state = await createOpenClawTestState({
  scenario: "minimal",
  env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
});
let projection;
let profiler;
const subscribers = createSessionMessageSubscriberRegistry();
try {
  const storePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
  const databaseOptions = { agentId: "main", path: storePath };
  const cfg = {
    agents: { entries: { main: {} } },
    session: { store: storePath, maintenance: { coldStorage: { enabled: true, afterDays: 30 } } },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const scopes = Array.from({ length: count + 1 }, (_, i) => ({
    agentId: "main",
    storePath,
    sessionKey: `agent:main:synthetic-cold-${i}`,
    sessionId: `history-${i}`,
  }));
  for (const [i, scope] of scopes.entries()) {
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const events = [{ type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION }];
    for (let j = 0; j < 256; j++) {
      events.push({
        type: "message",
        id: `m-${j}`,
        parentId: j ? `m-${j - 1}` : null,
        timestamp: new Date(j + 1).toISOString(),
        message: {
          role: j % 2 ? "assistant" : "user",
          content: [
            { type: "text", text: `Synthetic event ${j}: ` + "history payload ".repeat(128) },
          ],
        },
      });
    }
    runOpenClawAgentWriteTransaction(
      (database) =>
        replaceSqliteTranscriptEventsInTransaction(
          database,
          resolveSqliteTranscriptScope(scope),
          events,
        ),
      databaseOptions,
      { operationLabel: "session.transcript.replace" },
    );
    replaceSessionEntrySync(scope, { sessionId: `current-${i}`, updatedAt: 1 });
  }
  await waitForSessionTranscriptIndexReconcilesInStateDir(state.stateDir);
  runOpenClawAgentWriteTransaction(
    ({ db }) =>
      db.exec(
        "UPDATE session_windows SET previous_session_id = NULL; UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1 WHERE session_id LIKE 'history-%';",
      ),
    databaseOptions,
  );
  if (mode !== "hot") {
    let archived = 0;
    while (archived < scopes.length) {
      const result = await runSessionColdStorageMaintenance({ config: cfg });
      assert(result.archivedTranscripts > 0, "fixture archival stopped early");
      archived += result.archivedTranscripts;
    }
  }
  const empty = () => {};
  const context = {
    getRuntimeConfig: () => cfg,
    getCommittedRuntimeConfig: () => cfg,
    loadGatewayModelCatalog: async () => [],
    loadGatewayModelCatalogSnapshot: async () => ({
      agentId: "main",
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: cfg,
      entries: [],
      routeVariants: [],
      catalogComplete: true,
    }),
    logGateway: { info: empty, warn: empty, error: empty, debug: empty, isEnabled: () => false },
    agentRunSeq: new Map(),
    chatRunState: createChatRunState(),
    addChatRun: empty,
    removeChatRun: empty,
    broadcast: empty,
    broadcastToConnIds: empty,
    getSessionEventSubscriberConnIds: () => new Set(),
    forgetConnectionAncestors: empty,
    nodeSendToSession: empty,
    registerToolEventRecipient: empty,
    trackExecution: trackAsyncWork,
    readChatMetadata: async () => {
      throw new Error("No synthetic metadata");
    },
    dedupe: new Map(),
    subscribeSessionMessageEvents: subscribers.subscribe,
    unsubscribeSessionMessageEvents: subscribers.unsubscribe,
  };
  projection = await createSessionRowProjection({
    cfg,
    getConfig: () => cfg,
    getPolicyConfig: () => cfg,
    getModelCatalog: () => [],
    context,
  });
  bindSessionRowProjection(context, () => projection);
  await projection.ensureMaterialized();
  const client = {
    connId: "synthetic-reader",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "synthetic",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.admin"],
    },
  };
  const request = async (scope) => {
    let response;
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "measure",
        method: "sessions.messages.subscribe",
        params: { key: scope.sessionKey, initialHistory: { limit: 80, maxBytes: 256 * 1024 } },
      },
      client,
      context,
      respond: (...args) => {
        response = args;
      },
      isWebchatConnect: () => false,
      extraHandlers: sessionSubscriptionHandlers,
    });
    assert.equal(response?.[0], true, "subscription failed");
    assert.equal(response[1].initialHistory?.ok, true, "initial history failed");
    return response[1].initialHistory.payload;
  };
  await request(scopes.at(-1));
  for (const scope of scopes) {
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  }
  // Warm one disposable historical session so module and worker startup is excluded.
  await request(scopes.at(-1));
  const samples = [];
  const before = process.memoryUsage();
  const hostLoadBefore = loadavg();
  if (instrumentation === "allocation") {
    profiler = new Session();
    profiler.connect();
    await profiler.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  let retained = 0;
  for (const scope of scopes.slice(0, count)) {
    const enter = createDeferredCore(),
      release = createDeferredCore();
    let writer,
      timer,
      released = false;
    try {
      if (mode === "busy") {
        writer = runOpenClawAgentWriteAdmission(databaseOptions, async () => {
          enter.resolve();
          await release.promise;
        });
        await enter.promise;
        timer = setTimeout(() => {
          released = true;
          release.resolve();
        }, 1000);
      }
      const started = performance.now(),
        cpu = process.cpuUsage(),
        mainThreadCpu = process.threadCpuUsage();
      const payload = await request(scope);
      const used = process.cpuUsage(cpu),
        mainThreadUsed = process.threadCpuUsage(mainThreadCpu),
        ms = performance.now() - started;
      assert.equal(payload.messages.length, 80, "bounded history page length");
      assert.equal(
        payload.messages.at(-1).content[0].text,
        `Synthetic event 255: ` + "history payload ".repeat(128),
        "latest message content",
      );
      samples.push({
        wallMs: ms,
        cpuMs: (used.user + used.system) / 1000,
        mainThreadCpuMs: (mainThreadUsed.user + mainThreadUsed.system) / 1000,
        writerReleased: released,
      });
      if (
        readSessionColdTranscript(openOpenClawAgentDatabase(databaseOptions).db, scope.sessionId)
      ) {
        retained++;
      }
    } finally {
      clearTimeout(timer);
      release.resolve();
      await writer;
    }
  }
  let allocatedBytes;
  if (profiler) {
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    allocatedBytes = 0;
    const visit = (n) => {
      allocatedBytes += n.selfSize;
      for (const child of n.children ?? []) {
        visit(child);
      }
    };
    visit(profile.head);
    profiler.disconnect();
    profiler = undefined;
  }
  const sorted = samples.map((s) => s.wallMs).toSorted((a, b) => a - b);
  console.log(
    JSON.stringify({
      mode,
      instrumentation,
      iterations: count,
      messagesPerTranscript: 256,
      sourceRoot: root,
      p50Ms: sorted[Math.ceil(count * 0.5) - 1],
      p99Ms: sorted[Math.ceil(count * 0.99) - 1],
      p99ContextOnly: count < 1000,
      cpuMs: samples.reduce((a, s) => a + s.cpuMs, 0),
      mainThreadCpuMs: samples.reduce((a, s) => a + s.mainThreadCpuMs, 0),
      sampledMainAllocatedBytes: allocatedBytes,
      archivesRetained: retained,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      before,
      after: process.memoryUsage(),
      samples,
    }),
  );
} finally {
  profiler?.disconnect();
  subscribers.unsubscribeAll("synthetic-reader");
  projection?.dispose();
  await state.cleanup();
}
