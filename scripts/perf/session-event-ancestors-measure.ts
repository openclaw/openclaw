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
 * Wide-parent single-revision arm (run base/candidate in separate processes):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-event-ancestors-measure.ts \
 *   --arm candidate --shape wide --sessions 151 --clients 20 --pairs 1 --events 3000
 * Use 51/151/501 sessions for 50/150/500 children. --churn state alternates one child's
 * persisted terminal status (failed/done) before each publication. Compare timing and allocation separately,
 * counterbalance process order, and require matching normalizedPayloadDigest values.
 * Wide-parent acceptance: child-count-independent membership reads and lower CPU/event;
 * wire bytes must match after only the generated ancestor revision normalization above.
 * This measures the publication owner, not whole-Gateway latency or production share.
 * Daytime roster workload: --sessions 10800 --active-sessions 20 --clients 40
 * --capabilities current --churn state. --roster-clients optionally restricts broad
 * subscriptions; other connections receive no lifecycle rows.
 * --counts instruments row work separately from timing/allocation measurements.
 * --cpu-profile records only measured publications, excluding startup and warmup.
 * --warmup sets minimum warmup events per arm (default 1000).
 * --burst 20 queues 20 distinct session publications before draining; --live-runs
 * registers live run facts for selected leaves. --audiences sets viewer identities
 * (default two for trees, one per connection for wide parents).
 * --fixture reuses an owned, offline team-shape-fixture.ts state directory. It updates
 * session metadata in place, preserves transcript identities/workspaces, and never deletes it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type {
  GatewayBroadcastToConnIdsFn,
  PrepareSessionEventProjection,
} from "../../src/gateway/server-broadcast-types.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    arm: { type: "string" },
    shape: { type: "string", default: "tree" },
    churn: { type: "string", default: "steady" },
    owner: { type: "string", default: "src/gateway/server-chat-lifecycle-publication.ts" },
    "base-owner": { type: "string" },
    pairs: { type: "string", default: "5" },
    events: { type: "string", default: "3000" },
    warmup: { type: "string", default: "1000" },
    burst: { type: "string", default: "1" },
    "live-runs": { type: "boolean", default: false },
    audiences: { type: "string" },
    sessions: { type: "string", default: "1600" },
    clients: { type: "string", default: "10" },
    "active-sessions": { type: "string" },
    "roster-clients": { type: "string" },
    capabilities: { type: "string", default: "legacy" },
    counts: { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
    profiles: { type: "boolean", default: false },
    fixture: { type: "string" },
    "state-root": { type: "string", default: ".local/session-event-ancestors-measure" },
  },
});
assert(values.arm || values["base-owner"], "Use --arm or --base-owner");
assert(["tree", "wide"].includes(values.shape));
assert(["steady", "state"].includes(values.churn));
assert(["legacy", "current"].includes(values.capabilities));
assert(!values.allocations || !values["cpu-profile"], "Profile CPU and allocation separately");
const wide = values.shape === "wide";
const integer = (
  name:
    | "events"
    | "warmup"
    | "burst"
    | "audiences"
    | "pairs"
    | "sessions"
    | "clients"
    | "active-sessions"
    | "roster-clients",
  fallback: number,
) => parseStrictIntegerOption({ raw: values[name], label: name, min: 1, fallback });
const events = integer("events", 3000);
const warmup = integer("warmup", 1000);
const burst = integer("burst", 1);
const pairs = integer("pairs", 5);
const sessions = integer("sessions", 1600);
const clientCount = integer("clients", 10);
const audiences = integer("audiences", wide ? clientCount : 2);
const activeSessions = integer("active-sessions", wide ? sessions - 1 : sessions / 4);
const rosterClients = integer("roster-clients", clientCount);
assert(activeSessions <= (wide ? sessions - 1 : sessions / 4));
assert(rosterClients <= clientCount);
assert(audiences <= clientCount);
assert(
  wide ? sessions >= 2 : sessions >= 4 && sessions % 4 === 0,
  "Invalid session count for shape",
);
const stateRoot = path.resolve(values["state-root"]);
const fixtureRoot = values.fixture ? realpathSync(values.fixture) : undefined;
const fixtureSummary: unknown = fixtureRoot
  ? JSON.parse(readFileSync(path.join(fixtureRoot, "team-shape-summary.json"), "utf8"))
  : undefined;
const fixtureConfig: OpenClawConfig | undefined = fixtureRoot
  ? JSON.parse(readFileSync(path.join(fixtureRoot, "openclaw.json"), "utf8"))
  : undefined;
if (fixtureRoot) {
  assert(isRecord(fixtureSummary) && fixtureSummary.format === "openclaw-team-shape-v1");
  assert(fixtureSummary.sessionCount === sessions && fixtureSummary.agentCount === 1);
  assert(
    typeof fixtureSummary.profile === "string" && fixtureSummary.profile.startsWith("team-shape-"),
  );
  assert(
    fixtureConfig?.gateway?.bind === "loopback" && fixtureConfig.gateway.auth?.mode === "none",
  );
  assert(fixtureConfig.plugins?.enabled === false && fixtureConfig.cron?.enabled === false);
  assert(fixtureConfig.agents?.entries?.main?.workspace === path.join(fixtureRoot, "workspace"));
}
mkdirSync(stateRoot, { recursive: true });
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = stateRoot;
const owner = path.resolve(values.owner);
const baseOwner = path.resolve(values["base-owner"] ?? values.owner);
type Owner = typeof import("../../src/gateway/server-chat-lifecycle-publication.js");
const candidate: Owner = await import(pathToFileURL(owner).href);
const base: Owner = await import(pathToFileURL(baseOwner).href);
const variants = values.arm
  ? [{ name: values.arm, create: candidate.createSessionLifecyclePublisher, source: owner }]
  : [
      { name: "base", create: base.createSessionLifecyclePublisher, source: baseOwner },
      { name: "candidate", create: candidate.createSessionLifecyclePublisher, source: owner },
    ];
const [
  { withOpenClawTestState },
  { writeSessionEntry, readExactSessionEntryRow, readSessionEntryCount },
  { runOpenClawAgentWriteTransaction },
  { createSessionRowProjection },
  { drainSessionEventPublications },
  { createSessionEventSubscriberRegistry },
  { ConnectionSessionRows },
  { setRuntimeConfigSnapshot },
  { registerAgentRunContext, clearAgentRunContext },
  { createVisibleActiveSessionRunProjector, resolveVisibleActiveSessionRunState },
  { prepareUserProfileCatalog },
  { cleanupSessionStateForTest },
] = await Promise.all([
  import("../../src/test-utils/openclaw-test-state.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/gateway/session-row-projection.js"),
  import("../../src/gateway/session-event-prepared-row.js"),
  import("../../src/gateway/server-chat-state.js"),
  import("../../src/gateway/session-ancestor-references.js"),
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/infra/agent-run-registry.js"),
  import("../../src/gateway/server-methods/session-active-runs.js"),
  import("../../src/state/user-profile-list.js"),
  import("../../src/test-utils/session-state-cleanup.js"),
]);
const withBenchmarkState = (consume: () => Promise<void>) =>
  withOpenClawTestState(
    {
      scenario: "minimal",
      prepareProfileCatalog: !fixtureRoot,
      ...(fixtureRoot
        ? {
            env: {
              OPENCLAW_STATE_DIR: fixtureRoot,
              OPENCLAW_CONFIG_PATH: path.join(fixtureRoot, "openclaw.json"),
              OPENCLAW_AGENT_DIR: path.join(fixtureRoot, "agents", "main", "agent"),
            },
          }
        : {}),
    },
    async () => {
      let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
      try {
        catalog = fixtureRoot ? await prepareUserProfileCatalog() : undefined;
        await consume();
      } finally {
        Date.now = previousNow;
        catalog?.release();
        if (fixtureRoot) {
          await cleanupSessionStateForTest({ stateDir: fixtureRoot, rootPath: fixtureRoot });
        }
      }
    },
  );
const anchor = Date.UTC(2026, 9, 26);
const previousNow = Date.now;
const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
try {
  await withBenchmarkState(async () => {
    const cfg: OpenClawConfig = {
      ...fixtureConfig,
      agents: fixtureConfig?.agents ?? { entries: { main: {} } },
      plugins: { enabled: false },
      gateway: {
        ...fixtureConfig?.gateway,
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
    const sessionId = (index: number) =>
      `${fixtureRoot ? "team-shape-session" : "ancestor-measure"}-${index}`;
    const key = (index: number) =>
      fixtureRoot
        ? `agent:main:${sessionId(index)}`
        : wide
          ? index === 0
            ? "agent:main:parent"
            : `agent:main:subagent:measure-${index}`
          : `agent:main:ancestor-measure-${index}`;
    const fixtureChurn = new Map<string, readonly [InternalSessionEntry, InternalSessionEntry]>();
    let fixtureDatabaseBytes: number | undefined;
    runOpenClawAgentWriteTransaction(
      (database) => {
        // Admit genuine database receipts on wall time before freezing synthetic work.
        Date.now = () => anchor;
        if (fixtureRoot) {
          assert.equal(
            readSessionEntryCount(database),
            sessions,
            "Fixture session inventory changed",
          );
          fixtureDatabaseBytes = statSync(database.path).size;
        }
        for (let index = 0; index < sessions; index++) {
          const existing = fixtureRoot
            ? readExactSessionEntryRow(database, key(index))?.entry
            : undefined;
          if (fixtureRoot) {
            assert.equal(
              existing?.sessionId,
              sessionId(index),
              "Expected canonical synthetic session identity",
            );
          }
          const entry: InternalSessionEntry = {
            ...existing,
            sessionId: sessionId(index),
            updatedAt: anchor - index,
            status: "done",
            visibility: "shared",
            label: `Synthetic ancestor row ${index}`,
            ...(fixtureRoot
              ? { archivedAt: undefined, spawnedBy: undefined, parentSessionKey: undefined }
              : {}),
            ...(wide
              ? index
                ? { spawnedBy: key(0), parentSessionKey: key(0) }
                : {}
              : index % 4
                ? { spawnedBy: key(index - 1) }
                : {}),
          };
          writeSessionEntry(database, key(index), entry);
          if (
            fixtureRoot &&
            (wide
              ? index > 0 && index <= activeSessions
              : index % 4 === 3 && index < activeSessions * 4)
          ) {
            fixtureChurn.set(key(index), [{ ...entry }, { ...entry, status: "failed" }]);
          }
        }
        if (fixtureRoot) {
          assert.equal(readSessionEntryCount(database), sessions);
        }
      },
      { agentId: "main" },
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const inspector = new Session();
    const runIds: string[] = [];
    const peers = Array.from({ length: clientCount }, (_, index) => {
      const profileId = `synthetic-profile-${index % audiences}`;
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
            caps:
              values.capabilities === "current"
                ? ["session-row-deltas", "session-event-field-refs"]
                : [],
          },
        } satisfies GatewayClient,
        rows: new ConnectionSessionRows(),
      };
    });
    try {
      const leaves = wide
        ? Array.from({ length: activeSessions }, (_, index) => key(index + 1))
        : Array.from({ length: activeSessions }, (_, index) => key(index * 4 + 3));
      if (values["live-runs"]) {
        for (const [index, sessionKey] of leaves.entries()) {
          const runId = `synthetic-run-${index}`;
          runIds.push(runId);
          registerAgentRunContext(runId, {
            agentId: "main",
            sessionKey,
            sessionId: sessionId(wide ? index + 1 : index * 4 + 3),
            projectSessionActive: true,
            lifecycleStartedAt: anchor - 60_000,
            activeModel: { provider: "mock", model: "fixture" },
          });
        }
      }
      await projection.ensureMaterialized();
      const subscribers = createSessionEventSubscriberRegistry();
      const references = new Map<GatewayClient, InstanceType<typeof ConnectionSessionRows>>(
        peers.map((peer) => [peer.client, peer.rows]),
      );
      for (const peer of peers.slice(0, rosterClients)) {
        subscribers.subscribe(peer.client.connId);
      }
      const context: Parameters<PrepareSessionEventProjection>[3] = {
        isCurrentProjection: (current) => current === projection,
        resolveAgentScope: () => ["main", "main", undefined],
        forgetAncestors: () => {},
        references: (client) => references.get(client)!,
        createRunProjector: () =>
          values["live-runs"]
            ? createVisibleActiveSessionRunProjector(
                projection.state.rowContext.projectedAgentRuns,
                undefined,
                undefined,
                projection.physicalPaths,
              )
            : () => ({ active: false }),
      };
      if (values["live-runs"]) {
        const project = context.createRunProjector();
        for (const [index, sessionKey] of leaves.entries()) {
          assert(
            project({
              requestedKey: sessionKey,
              canonicalKey: sessionKey,
              agentId: "main",
              sessionId: sessionId(wide ? index + 1 : index * 4 + 3),
            }).active,
            "Registered fixture runs must be visible through the production run projector",
          );
        }
      }
      let membershipReads = 0;
      let describes = 0;
      let presents = 0;
      let selections = 0;
      let describedRows = 0;
      let presentedRows = 0;
      const eventDescribedRows = new Set<object>();
      const eventPresentedRows = new Set<object>();
      let countingConsume = false;
      if (values.counts) {
        const describe = projection.describe.bind(projection);
        projection.describe = (...args) => {
          describes++;
          const row = describe(...args);
          if (countingConsume && row) {
            eventDescribedRows.add(row.materialized);
          }
          return row;
        };
        const present = projection.present.bind(projection);
        projection.present = (...args) => {
          presents++;
          if (countingConsume) {
            eventPresentedRows.add(args[0].materialized);
          }
          return present(...args);
        };
        const select = projection.selectEntries.bind(projection);
        projection.selectEntries = (...args) => {
          selections++;
          return select(...args);
        };
      }
      let consumeMs: number[] = [];
      const readMembership = projection.readMembership.bind(projection);
      projection.readMembership = (...args) => {
        membershipReads++;
        return readMembership(...args);
      };
      const withPrepared = projection.withPreparedExactRows.bind(projection);
      projection.withPreparedExactRows = (queries, consume, options) =>
        withPrepared(
          queries,
          (read) => {
            if (values.counts) {
              eventDescribedRows.clear();
              eventPresentedRows.clear();
              countingConsume = true;
            }
            const started = performance.now();
            try {
              return consume(read);
            } finally {
              consumeMs.push(performance.now() - started);
              if (values.counts) {
                describedRows += eventDescribedRows.size;
                presentedRows += eventPresentedRows.size;
                countingConsume = false;
              }
            }
          },
          options,
        );
      let ancestorTraversals = 0;
      let frames = 0;
      let verifyAncestors = false;
      let digest: ReturnType<typeof createHash> | undefined;
      const normalizeAncestorToken = (row: unknown, field: string): Record<string, unknown> => {
        assert(isRecord(row));
        if (isRecord(row.full)) {
          return { ...row, full: normalizeAncestorToken(row.full, field) };
        }
        if (isRecord(row.set)) {
          return { ...row, set: normalizeAncestorToken(row.set, field) };
        }
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
          if (!connIds.has(peer.client.connId)) {
            continue;
          }
          const projected = project(peer.client);
          assert(projected, "Shared synthetic row must reach each recipient");
          if (verifyAncestors) {
            const payload: unknown = projected.payload;
            assert(payload && typeof payload === "object" && "ancestorSessions" in payload);
            assert(Array.isArray(payload.ancestorSessions));
            assert.equal(
              payload.ancestorSessions.length,
              wide ? 1 : 3,
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
          ...(values["live-runs"]
            ? {
                resolveSessionActiveRunState: (
                  params: Parameters<typeof resolveVisibleActiveSessionRunState>[0],
                ) =>
                  resolveVisibleActiveSessionRunState({
                    ...params,
                    defaultAgentId: "main",
                    projectedAgentRunIndex: projection.state.rowContext.projectedAgentRuns,
                    physicalPaths: projection.physicalPaths,
                  }),
              }
            : {}),
        }),
      );
      const run = async (variantIndex: number, count: number) => {
        for (let index = 0; index < count; index++) {
          // Sequential pairs exercise references; bursts admit distinct keys before draining.
          const leaf = (burst === 1 ? Math.floor(index / 2) : index) % leaves.length;
          const sessionKey = leaves[leaf]!;
          if (values.churn === "state") {
            const leafIndex = wide ? leaf + 1 : leaf * 4 + 3;
            runOpenClawAgentWriteTransaction(
              (database) => {
                const failed = (burst === 1 ? index : Math.floor(index / leaves.length)) % 2;
                const prepared = fixtureChurn.get(sessionKey)?.[failed ? 1 : 0];
                if (prepared) {
                  // The synchronous writer publishes decoded snapshots, not this owned input.
                  prepared.updatedAt = anchor + index + 1;
                }
                writeSessionEntry(
                  database,
                  sessionKey,
                  prepared ?? {
                    sessionId: sessionId(leafIndex),
                    updatedAt: anchor + index + 1,
                    status: failed ? "failed" : "done",
                    visibility: "shared",
                    label: `Synthetic ancestor row ${leafIndex}`,
                    spawnedBy: key(wide ? 0 : leafIndex - 1),
                    ...(wide ? { parentSessionKey: key(0) } : {}),
                  },
                );
              },
              { agentId: "main" },
            );
          }
          const runId = runIds[leaf] ?? "synthetic-run";
          publishers[variantIndex]!.publish({
            phase: "model",
            sessionKey,
            agentId: "main",
            clientRunId: runId,
            runContext: undefined,
            event: {
              runId,
              seq: index,
              stream: "lifecycle",
              ts: anchor,
              data: {},
              sessionKey,
            },
          });
          if ((index + 1) % burst === 0 || index + 1 === count) {
            await drainSessionEventPublications(projection);
          }
        }
      };
      const clearHistories = () => {
        for (const peer of peers) {
          peer.rows.clear();
          // A live connection's clear preserves wire versions; each arm starts a fresh history.
          peer.rows = new ConnectionSessionRows();
          references.set(peer.client, peer.rows);
        }
      };
      for (const index of variants.keys()) {
        await run(index, Math.max(warmup, leaves.length));
      }
      const digests: string[] = [];
      for (const index of variants.keys()) {
        clearHistories();
        verifyAncestors = true;
        digest = createHash("sha256");
        await run(index, leaves.length * 2);
        digests.push(digest.digest("hex"));
        digest = undefined;
      }
      if (variants.length > 1) {
        assert.equal(digests[0], digests[1], "Normalized recipient payload bytes must match");
      }
      if (values.allocations || values["cpu-profile"]) {
        inspector.connect();
      }
      if (values["cpu-profile"]) {
        await inspector.post("Profiler.enable");
      }
      const results = [];
      for (let pair = 0; pair < pairs; pair++) {
        for (const index of values.arm ? [0] : pair % 2 ? [1, 0] : [0, 1]) {
          clearHistories();
          globalThis.gc?.();
          ancestorTraversals = 0;
          frames = 0;
          membershipReads = 0;
          describes = presents = selections = describedRows = presentedRows = 0;
          consumeMs = [];
          if (values.allocations) {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 4096,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          if (values["cpu-profile"]) {
            await inspector.post("Profiler.start");
          }
          const hostLoadBefore = loadavg();
          const memoryBefore = process.memoryUsage();
          const materializedBefore = projection.materializedCount;
          const cpu = process.threadCpuUsage();
          const started = performance.now();
          await run(index, events);
          const elapsedMs = performance.now() - started;
          const used = process.threadCpuUsage(cpu);
          const memoryAfter = process.memoryUsage();
          assert.equal(frames, events * rosterClients);
          let allocatedBytes: number | undefined;
          if (values["cpu-profile"]) {
            const { profile } = await inspector.post("Profiler.stop");
            writeFileSync(
              path.join(stateRoot, `${variants[index]!.name}-${pair}.cpuprofile`),
              JSON.stringify(profile),
            );
          }
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
            materializationsPerEvent: (projection.materializedCount - materializedBefore) / events,
            membershipReadsPerEvent: membershipReads / events,
            ...(values.counts
              ? {
                  describesPerEvent: describes / events,
                  presentsPerEvent: presents / events,
                  selectionsPerEvent: selections / events,
                  distinctDescribedRowsPerEvent: describedRows / events,
                  distinctPresentedRowsPerEvent: presentedRows / events,
                  distinctDescribedRowsPerConsume: describedRows / consumeMs.length,
                  distinctPresentedRowsPerConsume: presentedRows / consumeMs.length,
                }
              : {}),
            consumeMeanMs: consumeMs.reduce((sum, value) => sum + value, 0) / consumeMs.length,
            consumeP99Ms: consumeMs.toSorted((a, b) => a - b)[Math.floor(consumeMs.length * 0.99)],
            consumeMaxMs: Math.max(...consumeMs),
            consumeStallsOver100Ms: consumeMs.filter((ms) => ms > 100).length,
            consumeSamples: consumeMs.length,
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
        shape: values.shape,
        churn: values.churn,
        sessions,
        ...(fixtureRoot
          ? {
              fixture: {
                root: fixtureRoot,
                summary: fixtureSummary,
                agentDatabaseBytesBeforeSetup: fixtureDatabaseBytes,
              },
            }
          : {}),
        leafSessions: leaves.length,
        clients: clientCount,
        rosterClients,
        capabilities: values.capabilities,
        counts: values.counts,
        burst,
        liveRuns: runIds.length,
        audiences,
        pairs,
        warmupEvents: Math.max(warmup, leaves.length),
        mode: values.allocations ? "allocation" : values["cpu-profile"] ? "cpu-profile" : "timing",
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
      for (const runId of runIds) {
        clearAgentRunContext(runId);
      }
      for (const peer of peers) {
        peer.rows.clear();
      }
      projection.dispose();
    }
  });
} finally {
  if (previousTmp === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmp;
  }
}
