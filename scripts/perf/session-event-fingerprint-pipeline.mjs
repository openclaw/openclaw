/** Real SQLite transcript writes, actor replicas, row preparation and event broadcast.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-event-fingerprint-pipeline.mjs
 * --diagnostic records field names/bytes/frozen state/identity only, never field contents.
 * Defaults: 2,000 synthetic sessions, 64 children, 20 clients across 3 audiences.
 * --allocations samples allocations separately; no production database contents are used.
 * In-process transport peers replace sockets; no synthetic prepared/frozen row inputs.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    diagnostic: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
    iterations: { type: "string", default: "128" },
    sessions: { type: "string", default: "2000" },
    children: { type: "string", default: "64" },
    output: { type: "string", default: ".local/lane2262-real/pipeline.json" },
    warmup: { type: "string", default: "32" },
  },
});
const warmup = Number(values.warmup);
const iterations = Number(values.iterations),
  sessions = Number(values.sessions),
  children = Number(values.children);
assert([iterations, sessions, children].every((n) => Number.isSafeInteger(n) && n > 0));
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
process.env.TMPDIR = path.dirname(output);
let context;
const ownerTimings = [];
const actorReceipts = [];
const identityIds = new WeakMap();
let nextIdentityId = 0;
const identityId = (value) => {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (!identityIds.has(value)) {
    identityIds.set(value, ++nextIdentityId);
  }
  return identityIds.get(value);
};
const calls = [],
  seen = new WeakSet(),
  prior = new Map(),
  encodings = new Map();
let phase = "setup";
let update = 0;
const hook = registerHooks({
  load(url, ctx, next) {
    if (
      values.diagnostic &&
      url === new URL("../../src/config/sessions/session-actor-receipt.ts", import.meta.url).href
    ) {
      let source = readFileSync(new URL(url), "utf8");
      source = source.replace(
        "  const { receipt } = outcome;\n  if (receipt.entryReference !== undefined)",
        "  const { receipt } = outcome;\n  const compacted = receipt.entryReference !== undefined;\n  if (receipt.entryReference !== undefined)",
      );
      source = source.replace(
        "  return outcome;\n}\n\nfunction collectAppendedEvents",
        '  Reflect.get(globalThis, "rowActorReceipt")(outcome, reference, compacted);\n  return outcome;\n}\n\nfunction collectAppendedEvents',
      );
      return { format: "module-typescript", source, shortCircuit: true };
    }
    if (url === new URL("../../src/infra/main-thread-stall.ts", import.meta.url).href) {
      const source = readFileSync(new URL(url), "utf8").replace(
        "  const observer = taskState.observer;",
        '  if (phase === "session-rows:consume") return Reflect.get(globalThis, "rowConsumeTiming")(name, run);\n  const observer = taskState.observer;',
      );
      return { format: "module-typescript", source, shortCircuit: true };
    }
    if (
      values.diagnostic &&
      url === new URL("../../src/gateway/session-row-delta-fields.ts", import.meta.url).href
    ) {
      let source = readFileSync(new URL(url), "utf8");
      // The diagnostic hook is confined to this process; production has no probe seam.
      source = source.replace(
        "    const value = row[field];",
        '    const value = row[field];\n    Reflect.get(globalThis, "rowHashVisit")(row.key, field, value);',
      );
      source = source.replace(
        '  return hash("sha256", encoded, "buffer").readBigUInt64BE();',
        '  Reflect.get(globalThis, "rowHashCall")(encoded);\n  return hash("sha256", encoded, "buffer").readBigUInt64BE();',
      );
      return { format: "module-typescript", source, shortCircuit: true };
    }
    return next(url, ctx);
  },
});
Reflect.set(globalThis, "rowConsumeTiming", (name, run) => {
  const cpu = process.threadCpuUsage(),
    started = performance.now();
  try {
    return run();
  } finally {
    const used = process.threadCpuUsage(cpu);
    ownerTimings.push({
      name,
      phase,
      update,
      wallMs: performance.now() - started,
      cpuUs: used.user + used.system,
    });
  }
});
Reflect.set(globalThis, "rowHashVisit", (key, field, value) => {
  context = { key, field, value };
});
Reflect.set(globalThis, "rowActorReceipt", (outcome, reference, compacted) => {
  const entry = outcome.receipt.postimage.entry;
  actorReceipts.push({
    phase,
    update,
    actorPhase: outcome.receipt.phase,
    compacted,
    entryIdentity: identityId(entry),
    toolOverridesIdentity: identityId(entry?.toolOverrides),
    referenceToolOverridesIdentity: identityId(reference?.entry?.toolOverrides),
    retainedToolOverrides: entry?.toolOverrides === reference?.entry?.toolOverrides,
  });
});
Reflect.set(globalThis, "rowHashCall", (encoded) => {
  const { key, field, value } = context;
  const object = value !== null && typeof value === "object";
  const previous = prior.get(`${key}\0${field}`);
  const known = encodings.get(`${key}\0${field}`) ?? new Set();
  calls.push({
    phase,
    update,
    key,
    field,
    bytes: Buffer.byteLength(encoded),
    nested: object,
    identity: object ? identityId(value) : null,
    deeplyFrozen: object ? deeplyFrozen(value) : null,
    seenIdentity: object ? seen.has(value) : null,
    equalBytesSeen: known.has(encoded),
    sameIdentity: previous ? previous.value === value : null,
    sameBytes: previous ? previous.encoded === encoded : null,
  });
  known.add(encoded);
  encodings.set(`${key}\0${field}`, known);
  if (object) {
    seen.add(value);
  }
  prior.set(`${key}\0${field}`, { value, encoded });
});
const { isDeeplyFrozenPlainData } = await import("../../src/shared/immutable-data.js");
const deeplyFrozen = isDeeplyFrozenPlainData;
const { runOpenClawAgentWriteTransaction } = await import("../../src/state/openclaw-agent-db.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { recordSessionParticipant } =
  await import("../../src/config/sessions/session-accessor.sqlite-participants.native.js");
const { replaceSessionEntrySync, persistSessionTranscriptTurn, updateSessionEntry } =
  await import("../../src/config/sessions/session-accessor.js");
const { acquireSessionInputActor, withSessionInputActor } =
  await import("../../src/config/sessions/session-input-actor.js");
const { createSessionRowProjection } = await import("../../src/gateway/session-row-projection.js");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { createGatewayConnectionState } =
  await import("../../src/gateway/server-connection-state.js");
const { createTestGatewayScheduler } =
  await import("../../src/test-utils/gateway-scheduler-clock.js");
const { prepareGatewayRecipientProfile } = await import("../../src/gateway/expected-profile.js");
const { ensureProfileForEmail } = await import("../../src/state/user-profiles.js");
const { setUserProfileRole } = await import("../../src/state/user-profile-writes.worker.js");
const { createTranscriptUpdateBroadcastHandler } =
  await import("../../src/gateway/server-session-events.js");
const { onSessionTranscriptUpdate } = await import("../../src/sessions/transcript-events.js");
const { broadcastSessionActivitySummary } =
  await import("../../src/gateway/session-activity-summary-events.js");
const { drainSessionEventPublications } =
  await import("../../src/gateway/session-event-prepared-row.js");
const { retainSessionListForegroundWork } =
  await import("../../src/gateway/session-projection-work.js");
const { resolveSessionStorePathCore } = await import("../../src/config/sessions/paths.js");
const { resolveOpenClawAgentSqlitePath } =
  await import("../../src/state/openclaw-agent-db.paths.js");
const originalNow = Date.now,
  originalUUID = crypto.randomUUID;
let id = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
syncBuiltinESMExports();
Date.now = () => 1_800_000_000_000 + update;
try {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = {
      agents: { defaults: { model: "synthetic/fixture" }, entries: { main: {} } },
      gateway: {
        roles: {
          default: "view",
          definitions: {
            view: {
              sessions: { others: "view" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
            write: {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const profiles = ["owner", "member", "viewer"].map((role) => {
      const p = ensureProfileForEmail(`hash-${role}@example.test`);
      setUserProfileRole(p.id, role === "member" ? "write" : "view");
      return p;
    });
    const root = "agent:main:hash-stream";
    const target = { agentId: "main", sessionKey: root, sessionId: "hash-stream" };
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: Date.now(),
      visibility: "shared",
      label: "Synthetic hash pipeline",
      createdActor: { type: "human", source: "profile", id: profiles[0].id },
      toolOverrides: {
        mcpToolsDeny: { synthetic: Array.from({ length: 2048 }, (_, i) => `synthetic-tool-${i}`) },
      },
      communication: {},
      inputTokens: 12000,
      outputTokens: 4000,
      totalTokens: 16000,
      modelProvider: "synthetic",
      model: "fixture",
      activitySummary: {
        version: 1,
        formatRevision: 3,
        text: "Synthetic recap. ".repeat(24),
        updatedAt: Date.now(),
        sessionId: target.sessionId,
        generation: null,
        maxSeq: null,
        leafEntryId: null,
        coveredMessages: 0,
        totalMessages: 0,
        omittedContent: false,
      },
    });
    for (const p of profiles.slice(1)) {
      recordSessionParticipant(target, {
        identity: { type: "profile", id: p.id },
        sessionAgentId: "main",
        promptedAt: Date.now(),
      });
    }
    // Batch only the cold fixture seed; measured actor publications remain individual commits.
    runOpenClawAgentWriteTransaction(
      () => {
        for (let i = 0; i < sessions; i++) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: `agent:main:hash-row-${i}` },
            {
              sessionId: `hash-row-${i}`,
              updatedAt: Date.now(),
              visibility: "shared",
              label: `Synthetic row ${i}`,
              ...(i < children ? { parentSessionKey: root } : {}),
            },
          );
        }
      },
      { agentId: "main" },
    );
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const connection = createGatewayConnectionState({
      cfg,
      scheduler: createTestGatewayScheduler(),
      bootId: "hash-pipeline",
    });
    const detach = connection.attachSessionRowProjection(projection);
    const frames = [];
    const peers = Array.from({ length: 20 }, (_, index) => {
      const profile = profiles[index % 3];
      const socket = Object.assign(new EventEmitter(), {
        readyState: 1,
        bufferedAmount: 0,
        send(frame, options, done) {
          frames.push({ recipient: index, wire: frame.toString() });
          (typeof options === "function" ? options : done)?.();
        },
        close() {},
        terminate() {},
      });
      const client = {
        connId: `hash-peer-${index}`,
        socket,
        usesSharedGatewayAuth: false,
        authenticatedUserId: profile.id,
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: profile.displayName,
          avatarRevision: "1",
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "openclaw-control-ui",
            version: "benchmark",
            platform: "benchmark",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          caps: ["session-scoped-events", "session-row-deltas", "session-event-field-refs"],
        },
      };
      prepareGatewayRecipientProfile(client);
      connection.clients.add(client);
      connection.sessionEventSubscribers.subscribe(client.connId);
      connection.sessionMessageSubscribers.subscribe(client.connId, root);
      return client;
    });
    const pending = new Set();
    const handler = createTranscriptUpdateBroadcastHandler({
      ...connection,
      getSessionRowProjection: () => projection,
    });
    const unsubscribe = onSessionTranscriptUpdate((event) => {
      const work = handler(event);
      pending.add(work);
      void work.finally(() => pending.delete(work));
    });
    const drain = async () => {
      while (pending.size) {
        await Promise.all(pending);
      }
      await drainSessionEventPublications(projection);
    };
    const observations = [];
    const inspector = new Session();
    let allocatedBytes;
    let inputActor;
    if (values.allocations) {
      inspector.connect();
    }
    try {
      await projection.ensureMaterialized();
      inputActor = await acquireSessionInputActor(
        {
          agentId: "main",
          storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
          target: { canonicalKey: root, storeKeys: [root] },
        },
        { assertCurrent() {}, assertReadable() {} },
      );
      assert(inputActor, "The fixture must acquire the real durable session actor");
      const persist = (options, actorPhase = "adoptRun") =>
        withSessionInputActor({ phase: actorPhase, acquire: async () => inputActor }, () =>
          persistSessionTranscriptTurn(target, options),
        );
      await persist(
        {
          touchSessionEntry: true,
          messages: [
            {
              eventId: "initial-input",
              message: {
                role: "user",
                content: "Run the synthetic streaming task",
                timestamp: Date.now(),
              },
            },
            {
              eventId: "initial",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Synthetic stable assistant text. ".repeat(512) }],
                timestamp: Date.now(),
              },
            },
          ],
        },
        "acceptInput",
      );
      await drain();
      for (update = 1; update <= iterations + warmup; update++) {
        if (update === warmup + 1) {
          global.gc?.();
          if (values.allocations) {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 4096,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
        }
        phase =
          update % 16 === 0
            ? "summary"
            : update % 8 === 0
              ? "model"
              : update % 4 === 0
                ? "usage"
                : update % 2 === 0
                  ? "tool-result"
                  : "tool-call";
        const frameStart = frames.length;
        const cpu = process.threadCpuUsage(),
          started = performance.now();
        if (phase === "usage" || phase === "model") {
          await updateSessionEntry(
            target,
            (entry) => ({
              outputTokens: (entry.outputTokens ?? 0) + 1,
              totalTokens: (entry.totalTokens ?? 0) + 1,
              ...(phase === "model"
                ? { model: update % 16 === 8 ? "fixture-a" : "fixture-b" }
                : {}),
            }),
            { skipMaintenance: true },
          );
        }
        if (phase === "summary") {
          if (update % 32 === 0) {
            await updateSessionEntry(
              target,
              (entry) => ({
                activitySummary: {
                  ...entry.activitySummary,
                  text: `Synthetic replacement recap ${update}. `.repeat(16),
                  updatedAt: Date.now(),
                },
              }),
              { skipMaintenance: true },
            );
          }
          await broadcastSessionActivitySummary(
            {
              key: root,
              agentId: "main",
              storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
            },
            { getSessionRowProjection: () => projection, broadcast: connection.broadcast },
          );
        } else {
          const message =
            update % 2
              ? {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: `call-${update}`,
                      name: "exec",
                      arguments: { command: `echo synthetic-${update}` },
                    },
                  ],
                }
              : {
                  role: "toolResult",
                  toolCallId: `call-${update - 1}`,
                  toolName: "exec",
                  content: [
                    {
                      type: "text",
                      text: `Synthetic tool output ${update}. ` + "fixture ".repeat(256),
                    },
                  ],
                  isError: false,
                };
          await persist({
            touchSessionEntry: true,
            expectedSessionId: target.sessionId,
            messages: [
              { eventId: `event-${update}`, message: { ...message, timestamp: Date.now() } },
            ],
          });
        }
        await drain();
        const used = process.threadCpuUsage(cpu);
        if (update > warmup) {
          observations.push({
            phase,
            update,
            frames: frames.length - frameStart,
            cpuUs: used.user + used.system,
            wallMs: performance.now() - started,
          });
        }
        assert.equal(frames.length - frameStart, 20, "Every update must reach every peer");
      }
      if (values.allocations) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
      }
      if (values.diagnostic) {
        assert.equal(
          actorReceipts.filter(
            ({ actorPhase }) => actorPhase === "acceptInput" || actorPhase === "adoptRun",
          ).length,
          1 + iterations + warmup - Math.floor((iterations + warmup) / 16),
          "Every transcript publication must cross the real actor receipt boundary",
        );
      }
      writeFileSync(
        output,
        JSON.stringify(
          {
            node: process.version,
            warmup,
            allocatedBytes,
            iterations,
            sessions,
            children,
            clients: 20,
            audiences: 3,
            load: loadavg(),
            observations,
            ownerTimings,
            calls,
            actorReceipts,
            frames,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          output,
          frames: frames.length,
          hashCalls: calls.length,
          actorReceipts: actorReceipts.length,
        }),
      );
    } finally {
      inspector.disconnect();
      unsubscribe();
      await drain();
      await inputActor?.actor.release();
      for (const peer of peers) {
        connection.clients.delete(peer);
      }
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
      release();
    }
  });
} finally {
  hook.deregister();
  Date.now = originalNow;
  crypto.randomUUID = originalUUID;
  syncBuiltinESMExports();
  Reflect.deleteProperty(globalThis, "rowConsumeTiming");
  Reflect.deleteProperty(globalThis, "rowHashVisit");
  Reflect.deleteProperty(globalThis, "rowHashCall");
  Reflect.deleteProperty(globalThis, "rowActorReceipt");
}
