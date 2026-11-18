// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/mention-inbox-reconnect-measure.ts
// Real mentions.list handler, SQLite worker, profiles, sharing and projection; no WebSocket.
// Compare --owner <saved mention-inbox.ts>; --allocation samples separately from timing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { MentionStoreSource } from "../../src/gateway/mention-inbox-store.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    clients: { type: "string", default: "100" },
    waves: { type: "string", default: "5" },
    allocation: { type: "boolean" },
  },
});
const clients = Number(values.clients);
const waves = Number(values.waves);
assert(Number.isSafeInteger(clients) && clients >= 30 && clients <= 100);
assert(Number.isSafeInteger(waves) && waves >= 1);
const stages: Record<string, { calls: number; ms: number }> = {};
const observer = Symbol.for("openclaw.bench.mention-stages");
Object.defineProperty(globalThis, observer, { value: stages });
const source = readFileSync(
  values.owner ?? new URL("../../src/gateway/mention-inbox.ts", import.meta.url),
  "utf8",
);
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    const names = url.endsWith("/gateway/mention-inbox.ts")
      ? ["maintain", "synchronize", "refreshConnectedViews", "publishConnectedViews", "readView"]
      : url.endsWith("/gateway/mention-inbox-targets.ts")
        ? ["prepareTargets"]
        : [];
    if (!names.length) {
      return loaded;
    }
    let text = url.endsWith("/gateway/mention-inbox.ts")
      ? stripTypeScriptTypes(source)
      : stripTypeScriptTypes(readFileSync(new URL(url), "utf8"));
    for (const name of names) {
      // These owner functions close at two-space indentation; instrument only their bodies.
      const pattern = new RegExp(`(function ${name}\\([^]*?\\)\\s*\\{)([^]*?)(\\n  \\})`);
      assert(pattern.test(text), `missing stage ${name}`);
      text = text.replace(
        pattern,
        `$1 const stageStart = performance.now(); try {$2\n} finally { const stages = globalThis[Symbol.for("openclaw.bench.mention-stages")]; const stage = stages["${name}"] ??= { calls: 0, ms: 0 }; stage.calls++; stage.ms += performance.now() - stageStart; }$3`,
      );
    }
    return { ...loaded, source: text };
  },
});
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { createTestGatewayScheduler } =
  await import("../../src/test-utils/gateway-scheduler-clock.js");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { runOpenClawAgentWriteTransaction } = await import("../../src/state/openclaw-agent-db.js");
const { ensureProfileForEmail } = await import("../../src/state/user-profiles.js");
const { prepareUserProfileCatalog } = await import("../../src/state/user-profile-list.js");
const { captureOpenClawStateWorkerContext } =
  await import("../../src/state/openclaw-state-worker-context.js");
const { commitMentionChanges, readMentionSnapshot } =
  await import("../../src/gateway/mention-inbox-worker.js");
const { createMentionInbox } = await import("../../src/gateway/mention-inbox.js");
const { gatewayConnect, gatewayProfile } =
  await import("../../src/gateway/server/client-fixtures.test-support.js");
const { mentionHandlers } = await import("../../src/gateway/server-methods/mentions.js");

await withOpenClawTestState({ scenario: "minimal" }, async () => {
  const cfg = {};
  setRuntimeConfigSnapshot(cfg);
  const profiles = Array.from({ length: 31 }, (_, i) =>
    ensureProfileForEmail(`person-${i}@reconnect.example.test`),
  );
  const catalog = await prepareUserProfileCatalog();
  const now = Date.now();
  const keys = Array.from({ length: 3000 }, (_, i) => `agent:main:reconnect-${i}`);
  // Offline fixture construction, before the inbox acquires any session readers.
  runOpenClawAgentWriteTransaction(
    (database) => {
      keys.forEach((sessionKey, i) =>
        writeSessionEntry(database, sessionKey, {
          sessionId: `session-${i}`,
          updatedAt: now,
          visibility: "shared",
          displayName: `Synthetic ${i}`,
        }),
      );
    },
    { agentId: "main" },
  );
  const context = captureOpenClawStateWorkerContext();
  const snapshot = await readMentionSnapshot(context, -1);
  assert(snapshot);
  const sources: MentionStoreSource[] = keys.map((sessionKey, i) => ({
    key: createHash("sha256").update(`source-${i}`).digest("hex"),
    sequence: i + 1,
    expiresAt: now + 7 * 86400000,
    recipients: [[profiles[1 + (i % 30)]!.id, `mention-${i}`]],
    message: {
      sessionId: `session-${i}`,
      content: {
        senderProfileId: profiles[0]!.id,
        sessionKey,
        agentId: "main",
        messageId: `message-${i}`,
        createdAt: now,
        excerpt: `Synthetic retained mention ${i}`,
      },
    },
  }));
  assert.equal(
    (
      await commitMentionChanges(
        context,
        {
          expectedHead: snapshot.head,
          nextSequence: sources.length + 1,
          changes: sources.map((item) => [item.key, item]),
        },
        () => context.admission.assertCurrent(),
      )
    ).kind,
    "committed",
  );
  const scheduler = createTestGatewayScheduler();
  let viewers: GatewayClient[] = [];
  let notifications = 0;
  const inbox = createMentionInbox({
    scheduler,
    gatewayInstanceId: "synthetic-reconnect",
    getRuntimeConfig: () => cfg,
    getClients: () => viewers,
    broadcastToConnIds: () => {
      notifications++;
    },
  });
  const handlerContext = { mentionInbox: inbox } as Parameters<
    NonNullable<(typeof mentionHandlers)["mentions.list"]>
  >[0]["context"];
  async function wave() {
    viewers = Array.from({ length: clients }, (_, i) => ({
      connId: `connection-${i}`,
      connect: gatewayConnect(["operator.admin"]),
      authenticatedUserProfile: gatewayProfile(profiles[1 + (i % 30)]!.id),
    }));
    const latencies: number[] = [];
    await Promise.all(
      viewers.map(async (client) => {
        const started = performance.now();
        await mentionHandlers["mentions.list"]!({
          req: { type: "req", id: client.connId!, method: "mentions.list", params: {} },
          client,
          params: {},
          context: handlerContext,
          isWebchatConnect: () => true,
          respond(ok, payload, error) {
            assert(ok, JSON.stringify(error));
            assert(
              payload &&
                typeof payload === "object" &&
                "items" in payload &&
                Array.isArray(payload.items),
            );
            assert.equal(payload.items.length, 100);
            latencies.push(performance.now() - started);
          },
        });
      }),
    );
    latencies.sort((a, b) => a - b);
    return { p50Ms: latencies[Math.floor(latencies.length / 2)], maxMs: latencies.at(-1) };
  }
  const inspector = new Session();
  try {
    const coldStart = performance.now();
    const coldCpu = process.cpuUsage();
    const coldLatency = await wave();
    const coldUsage = process.cpuUsage(coldCpu);
    const cold = {
      ...coldLatency,
      elapsedMs: performance.now() - coldStart,
      cpuMs: (coldUsage.user + coldUsage.system) / 1000,
      stages: structuredClone(stages),
    };
    for (let i = 0; i < 3; i++) {
      await wave();
    }
    global.gc?.();
    if (values.allocation) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const results = [];
    for (let i = 0; i < waves; i++) {
      for (const key of Object.keys(stages)) {
        delete stages[key];
      }
      const cpuStart = process.cpuUsage();
      const threadStart = process.threadCpuUsage();
      const started = performance.now();
      const latency = await wave();
      const cpu = process.cpuUsage(cpuStart);
      const thread = process.threadCpuUsage(threadStart);
      results.push({
        ...latency,
        elapsedMs: performance.now() - started,
        cpuMs: (cpu.user + cpu.system) / 1000,
        mainCpuMs: (thread.user + thread.system) / 1000,
        stages: structuredClone(stages),
      });
    }
    let allocatedBytes: number | undefined;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
        node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
      allocatedBytes = bytes(profile.head);
    }
    console.log(
      JSON.stringify({
        node: process.version,
        load: loadavg(),
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        clients,
        profiles: 30,
        retainedMentions: sources.length,
        sessions: keys.length,
        waves,
        notifications,
        cold,
        allocatedBytesPerWave: allocatedBytes === undefined ? undefined : allocatedBytes / waves,
        results,
      }),
    );
  } finally {
    inspector.disconnect();
    await inbox.dispose();
    await scheduler.stop();
    catalog.release();
  }
});
