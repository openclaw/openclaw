/**
 * Lifecycle publication owner benchmark: 1,600 resident sessions in four-level trees,
 * 400 changing leaf keys and 10 synthetic Control UI recipients. Runs the real lifecycle
 * publisher, prepared row/ancestor owners, recipient projection and delivery planner.
 * The in-process sink omits sockets; model-phase publications do not persist a turn.
 *
 * Save the base lifecycle publisher beside its source, then run:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-event-ancestors-measure.ts \
 *   --base-owner src/gateway/.base-lifecycle-publication.ts --pairs 5 --events 3000
 * Repeat with --allocations for a separate sampled-allocation pass. --profiles saves
 * profiles under --state-root. Pairs alternate AB/BA with setup and warmup excluded.
 * Acceptance: identical payloads after replacing generated ancestor revision UUIDs,
 * one ancestor traversal per publication instead of two, lower CPU/allocation.
 * This measures the publication owner, not whole-Gateway latency or production share.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type {
  GatewayBroadcastToConnIdsFn,
  PrepareSessionEventProjection,
} from "../../src/gateway/server-broadcast-types.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/gateway/server-chat-lifecycle-publication.ts" },
    "base-owner": { type: "string" },
    pairs: { type: "string", default: "5" },
    events: { type: "string", default: "3000" },
    sessions: { type: "string", default: "1600" },
    clients: { type: "string", default: "10" },
    allocations: { type: "boolean", default: false },
    profiles: { type: "boolean", default: false },
    "state-root": { type: "string", default: ".local/session-event-ancestors-measure" },
  },
});
assert(values["base-owner"], "--base-owner must name the saved source sibling");
const integer = (name: "events" | "pairs" | "sessions" | "clients", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], label: name, min: 1, fallback });
const events = integer("events", 3000);
const pairs = integer("pairs", 5);
const sessions = integer("sessions", 1600);
const clientCount = integer("clients", 10);
assert(sessions >= 4 && sessions % 4 === 0, "--sessions must be a multiple of four");
const stateRoot = path.resolve(values["state-root"]);
mkdirSync(stateRoot, { recursive: true });
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = stateRoot;
const owner = path.resolve(values.owner);
const baseOwner = path.resolve(values["base-owner"]);
type Owner = typeof import("../../src/gateway/server-chat-lifecycle-publication.js");
const candidate: Owner = await import(pathToFileURL(owner).href);
const base: Owner = await import(pathToFileURL(baseOwner).href);
const variants = [
  { name: "base", create: base.createSessionLifecyclePublisher, source: baseOwner },
  { name: "candidate", create: candidate.createSessionLifecyclePublisher, source: owner },
];
const [
  { withOpenClawTestState },
  { writeSessionEntry },
  { runOpenClawAgentWriteTransaction },
  { createSessionRowProjection },
  { drainSessionEventPublications },
  { createSessionEventSubscriberRegistry },
  { ConnectionSessionRows },
  { setRuntimeConfigSnapshot },
] = await Promise.all([
  import("../../src/test-utils/openclaw-test-state.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/gateway/session-row-projection.js"),
  import("../../src/gateway/session-event-prepared-row.js"),
  import("../../src/gateway/server-chat-state.js"),
  import("../../src/gateway/session-ancestor-references.js"),
  import("../../src/config/runtime-snapshot.js"),
]);
const anchor = Date.UTC(2026, 9, 26);
const previousNow = Date.now;
Date.now = () => anchor;
const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
try {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      plugins: { enabled: false },
      gateway: {
        roles: {
          default: "viewer",
          definitions: {
            viewer: {
              sessions: { others: "view" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const key = (index: number) => `agent:main:ancestor-measure-${index}`;
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < sessions; index++) {
          writeSessionEntry(database, key(index), {
            sessionId: `ancestor-measure-${index}`,
            updatedAt: anchor - index,
            status: "done",
            visibility: "shared",
            label: `Synthetic ancestor row ${index}`,
            ...(index % 4 ? { spawnedBy: key(index - 1) } : {}),
          });
        }
      },
      { agentId: "main" },
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const inspector = new Session();
    const peers = Array.from({ length: clientCount }, (_, index) => {
      const profileId = `synthetic-profile-${index % 2}`;
      return {
        client: {
          connId: `synthetic-connection-${index}`,
          authenticatedUserId: profileId,
          authenticatedUserProfile: {
            profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
          preparedSessionProfile: {
            profileId,
            aliases: new Set([profileId]),
            role: "viewer",
            githubLogin: null,
          },
          connect: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: "openclaw-control-ui", version: "bench", platform: "bench", mode: "ui" },
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            caps: [],
          },
        } satisfies GatewayClient,
        rows: new ConnectionSessionRows(),
      };
    });
    try {
      await projection.ensureMaterialized();
      const leaves = Array.from({ length: sessions / 4 }, (_, index) => key(index * 4 + 3));
      const subscribers = createSessionEventSubscriberRegistry();
      const references = new Map<GatewayClient, InstanceType<typeof ConnectionSessionRows>>(
        peers.map((peer) => [peer.client, peer.rows]),
      );
      for (const peer of peers) {
        subscribers.subscribe(peer.client.connId);
      }
      const context: Parameters<PrepareSessionEventProjection>[3] = {
        isCurrentProjection: (current) => current === projection,
        resolveAgentScope: () => ["main", "main", undefined],
        forgetAncestors: () => {},
        references: (client) => references.get(client)!,
        createRunProjector: () => () => ({ active: false }),
      };
      let ancestorTraversals = 0;
      let frames = 0;
      let verifyAncestors = false;
      let digest: ReturnType<typeof createHash> | undefined;
      const normalizeAncestorToken = (row: unknown, field: string) => {
        assert(isRecord(row));
        if (!Object.hasOwn(row, field)) {
          return row;
        }
        assert.equal(typeof row[field], "string");
        return { ...row, [field]: "revision" };
      };
      const ancestorRows = projection.ancestorRows;
      projection.ancestorRows = (...args) => {
        ancestorTraversals++;
        return ancestorRows(...args);
      };
      const broadcast: GatewayBroadcastToConnIdsFn = (event, sourcePayload, connIds, options) => {
        const project = options?.prepareSessionProjection?.(
          event,
          sourcePayload,
          { sessionKeys: [], agentId: "main" },
          context,
        );
        assert(project, "Lifecycle publication must retain its prepared projector");
        for (const peer of peers) {
          assert(connIds.has(peer.client.connId));
          const projected = project(peer.client);
          assert(projected, "Shared synthetic row must reach each recipient");
          if (verifyAncestors) {
            const payload: unknown = projected.payload;
            assert(payload && typeof payload === "object" && "ancestorSessions" in payload);
            assert(Array.isArray(payload.ancestorSessions));
            assert.equal(
              payload.ancestorSessions.length,
              3,
              "Each leaf must publish its full lineage",
            );
          }
          if (digest) {
            // Only randomly generated reference tokens vary between equivalent publications.
            const payload: unknown = projected.payload;
            assert(isRecord(payload));
            digest.update(
              JSON.stringify({
                ...payload,
                ...(Array.isArray(payload.ancestorSessions)
                  ? {
                      ancestorSessions: payload.ancestorSessions.map((row) =>
                        normalizeAncestorToken(row, "ancestorRevision"),
                      ),
                    }
                  : {}),
                ...(Array.isArray(payload.ancestorSessionRefs)
                  ? {
                      ancestorSessionRefs: payload.ancestorSessionRefs.map((row) =>
                        normalizeAncestorToken(row, "revision"),
                      ),
                    }
                  : {}),
              }),
            );
          }
          projected.delivered?.(peer.client);
          frames++;
        }
        verifyAncestors = false;
      };
      const publishers = variants.map((variant) =>
        variant.create({
          broadcastToConnIds: broadcast,
          sessionEventSubscribers: subscribers,
          getSessionRowProjection: () => projection,
          loadGatewaySessionLifecycleSnapshotForEvent(sessionKey, options) {
            const read = options?.sessionRows ?? projection;
            const row = read.describe({ key: sessionKey, agentId: "main" });
            return {
              row: row ? read.present(row) : null,
              lifecycleRunId: row?.entry.lifecycleRunId,
              storePath: row?.storeTarget.storePath,
            };
          },
          persistGatewaySessionLifecycleEventForEvent: async () => {},
        }),
      );
      const run = async (variantIndex: number, count: number) => {
        for (let index = 0; index < count; index++) {
          // Adjacent publications exercise both full ancestors and retained references.
          const sessionKey = leaves[Math.floor(index / 2) % leaves.length]!;
          publishers[variantIndex]!.publish({
            phase: "model",
            sessionKey,
            agentId: "main",
            clientRunId: "synthetic-run",
            runContext: undefined,
            event: {
              runId: "synthetic-run",
              seq: index,
              stream: "lifecycle",
              ts: anchor,
              data: {},
              sessionKey,
            },
          });
          await drainSessionEventPublications(projection);
        }
      };
      const clearHistories = () => {
        for (const peer of peers) {
          peer.rows.clear();
        }
      };
      for (const index of [0, 1]) {
        await run(index, leaves.length);
      }
      const digests: string[] = [];
      for (const index of [0, 1]) {
        clearHistories();
        verifyAncestors = true;
        digest = createHash("sha256");
        await run(index, leaves.length * 2);
        digests.push(digest.digest("hex"));
        digest = undefined;
      }
      assert.equal(digests[0], digests[1], "Normalized recipient payload bytes must match");
      if (values.allocations) {
        inspector.connect();
      }
      const results = [];
      for (let pair = 0; pair < pairs; pair++) {
        for (const index of pair % 2 ? [1, 0] : [0, 1]) {
          clearHistories();
          globalThis.gc?.();
          ancestorTraversals = 0;
          frames = 0;
          if (values.allocations) {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 4096,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const hostLoadBefore = loadavg();
          const memoryBefore = process.memoryUsage();
          const cpu = process.threadCpuUsage();
          const started = performance.now();
          await run(index, events);
          const elapsedMs = performance.now() - started;
          const used = process.threadCpuUsage(cpu);
          const memoryAfter = process.memoryUsage();
          assert.equal(frames, events * clientCount);
          assert.equal(ancestorTraversals, events * (variants[index]!.name === "base" ? 2 : 1));
          let allocatedBytes: number | undefined;
          if (values.allocations) {
            const { profile } = await inspector.post("HeapProfiler.stopSampling");
            allocatedBytes = sampledBytes(profile.head);
            if (values.profiles) {
              writeFileSync(
                path.join(stateRoot, `${variants[index]!.name}-${pair}.heapprofile`),
                JSON.stringify(profile),
              );
            }
          }
          const result = {
            pair,
            arm: variants[index]!.name,
            events,
            frames,
            ancestorTraversals,
            elapsedMs,
            threadCpuMs: (used.user + used.system) / 1000,
            cpuUsPerOperation: (used.user + used.system) / events,
            allocatedBytes,
            allocatedBytesPerOperation:
              allocatedBytes === undefined ? undefined : allocatedBytes / events,
            hostLoadBefore,
            hostLoadAfter: loadavg(),
            memoryBefore,
            memoryAfter,
          };
          results.push(result);
          console.log(JSON.stringify(result));
        }
      }
      const report = {
        node: process.version,
        sessions,
        leafSessions: leaves.length,
        clients: clientCount,
        pairs,
        mode: values.allocations ? "allocation" : "timing",
        normalizedPayloadDigest: digests[0],
        sources: variants.map((variant) => ({
          arm: variant.name,
          sha256: createHash("sha256").update(readFileSync(variant.source)).digest("hex"),
        })),
        results,
      };
      writeFileSync(
        path.join(stateRoot, `${report.mode}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.log(JSON.stringify(report));
    } finally {
      inspector.disconnect();
      for (const peer of peers) {
        peer.rows.clear();
      }
      projection.dispose();
    }
  });
} finally {
  Date.now = previousNow;
  if (previousTmp === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmp;
  }
}
