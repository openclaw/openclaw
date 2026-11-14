/**
 * Session event owner microbenchmark: 65 recipients, staggered histories, row deltas,
 * field references and legacy envelopes. Synthetic prepared rows replace only the
 * presentation boundary; the actual event projector and delivery planner run unchanged.
 * Access revision is fixed; retention accounting and broadcast diagnostics still run.
 * This measures owner CPU/allocation, not authorization or whole-Gateway latency.
 *
 * node --expose-gc --experimental-test-module-mocks --import ./scripts/tsx.mjs \
 *   scripts/perf/session-event-envelope-measure.ts --events 3000
 * Add --owner .local/base-projection.ts for a saved projection source, --delivery-owner
 * src/gateway/.delivery-baseline.ts to compare delta preparation, and --allocations
 * for a separate sampled-allocation pass. Alternate baseline/candidate timing and
 * allocation runs. Acceptance: identical payload digest, lower allocation and CPU;
 * report absolute costs and spread, and do not infer whole-Gateway tail changes.
 * --audiences selects distinct prepared row identities (default 2); use 8 with 65
 * clients to measure reuse within interleaved audiences rather than across all clients.
 * --distinct-viewers keeps each recipient's authorization key distinct while sharing
 * those prepared row identities, measuring equivalent views across viewer profiles.
 * --fresh-fields replaces every nested field per event to measure misses separately.
 * --profile <path> saves the sampled profile when used with --allocations.
 * Add --no-turbo-inlining to Node for callee attribution. Compare --clients 1/10/60
 * with --audiences 1/8/8 to distinguish single-recipient and audience fanout costs.
 * --sessions 64 rotates changing rows through the connection-owned delivery histories.
 * --reuse-envelope certifies the fixture's producer-owned envelope for both revisions.
 * --encode-envelopes includes payload encoding once per distinct projected payload.
 * The actual broadcaster and frame assembly run with inert socket sinks; use
 * --broadcast-owner <saved-source.ts> alongside --owner for baseline comparisons.
 * Histories follow 40/20/10 sidebar/dashboard/chat cohorts with staggered omissions.
 * --session-kib 128 --clients 70 --audiences 8 --distinct-viewers --source-revisions
 * exercises large changing session rows. UTF-8 counts and exact complete-frame
 * digests run in a separate replay, outside CPU/allocation. Compression is excluded.
 * --fields-owner <saved-source.ts> replaces only the field fingerprint owner.
 * --source-revisions replaces materialized rows for each transcript publication;
 * omit it to measure clock/runtime changes over unchanged materialized facts.
 * --yield-events gives each publication its own job, allowing weak samples to expire.
 * Both saved and current projection owners use the same native TypeScript loader.
 * With --expose-gc, memoryAfterGc reports retained memory after the measured pass
 * and a job boundary for weak samples. Collection precedes digest replay and is
 * outside CPU/allocation measurement.
 * Reports synchronous publication p99/max with sample counts; these are owner
 * stalls, not whole-Gateway event-loop or sessions.list latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SerializedGatewayFrame } from "../../src/gateway/serialized-json.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import type { GatewayWsClient } from "../../src/gateway/server/ws-types.js";
import type { SessionRowProjection } from "../../src/gateway/session-row-projection.js";
import type { GatewaySessionRow } from "../../src/gateway/session-utils.types.js";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.js";

const { values } = parseArgs({
  options: {
    "broadcast-owner": { type: "string", default: "src/gateway/server-broadcast.ts" },
    "session-kib": { type: "string", default: "0" },
    owner: { type: "string", default: "src/gateway/session-event-projection.ts" },
    "delivery-owner": { type: "string", default: "src/gateway/session-ancestor-references.ts" },
    "fields-owner": { type: "string", default: "src/gateway/session-row-delta-fields.ts" },
    events: { type: "string", default: "3000" },
    clients: { type: "string", default: "65" },
    audiences: { type: "string", default: "2" },
    "distinct-viewers": { type: "boolean", default: false },
    sessions: { type: "string", default: "1" },
    allocations: { type: "boolean", default: false },
    profile: { type: "string" },
    "encode-envelopes": { type: "boolean", default: false },
    "reuse-envelope": { type: "boolean", default: false },
    "fresh-fields": { type: "boolean", default: false },
    "source-revisions": { type: "boolean", default: false },
    "yield-events": { type: "boolean", default: false },
  },
});
const sessionKiB = Number(values["session-kib"]);
assert(Number.isSafeInteger(sessionKiB) && sessionKiB >= 0);
const largeText = "Synthetic 🦞\n".repeat(Math.ceil((sessionKiB * 1024) / 15));
const events = Number(values.events);
const clients = Number(values.clients);
const audiences = Number(values.audiences);
const sessions = Number(values.sessions);
assert(Number.isSafeInteger(events) && events > 0);
assert(Number.isSafeInteger(clients) && clients > 0);
assert(Number.isSafeInteger(sessions) && sessions > 0);
assert(Number.isSafeInteger(audiences) && audiences > 0 && audiences <= clients);
const owner = path.resolve(values.owner);
const ownerSha256 = createHash("sha256").update(readFileSync(owner)).digest("hex");
const fieldsOwner = path.resolve(values["fields-owner"]);
const fieldsUrl = new URL("../../src/gateway/session-row-delta-fields.ts", import.meta.url).href;
const fieldsSource = readFileSync(fieldsOwner, "utf8");
const fieldsHook = registerHooks({
  load(url, context, nextLoad) {
    return url === fieldsUrl
      ? { format: "module-typescript", source: fieldsSource, shortCircuit: true }
      : nextLoad(url, context);
  },
});
let key = "agent:main:stream-envelope";
let row: GatewaySessionRow;
let audienceRows: GatewaySessionRow[];
function audienceFor(client: GatewayClient): number {
  assert(client.connId);
  return Number(client.connId.slice("synthetic-".length)) % audiences;
}
mock.module(new URL("../../src/gateway/session-row-presentation.ts", import.meta.url), {
  namedExports: {
    prepareSessionRowPublication: () => (client: GatewayClient) => ({
      getAudienceKey: () =>
        values["distinct-viewers"] ? client.connId : String(audienceFor(client)),
      getPresentation: () => ({
        present: () => audienceRows[audienceFor(client)],
        sharing: {},
      }),
    }),
  },
});
mock.module(new URL("../../src/gateway/session-event-payload.ts", import.meta.url), {
  namedExports: {
    buildGatewaySessionSnapshot: () => {
      throw new Error("Benchmark must supply its prepared session snapshot");
    },
  },
});
mock.module(new URL("../../src/gateway/gateway-access-revision.ts", import.meta.url), {
  namedExports: { readGatewayAccessRevision: () => 0 },
});
const ownerUrl = new URL("../../src/gateway/session-event-projection.ts", import.meta.url).href;
const loadedOwnerUrl = `${ownerUrl}?measured-owner`;
const broadcastUrl = new URL("../../src/gateway/server-broadcast.ts", import.meta.url).href;
const loadedBroadcastUrl = `${broadcastUrl}?measured-owner`;
const ownerHook = registerHooks({
  load(url, context, nextLoad) {
    if (url === loadedBroadcastUrl) {
      return {
        format: "module-typescript",
        source: readFileSync(values["broadcast-owner"], "utf8"),
        shortCircuit: true,
      };
    }
    return url === loadedOwnerUrl
      ? {
          format: "module-typescript",
          source: readFileSync(owner, "utf8"),
          shortCircuit: true,
        }
      : nextLoad(url, context);
  },
});
const {
  prepareSessionEventProjection,
}: typeof import("../../src/gateway/session-event-projection.js") = await import(loadedOwnerUrl);
const { createGatewayBroadcaster }: typeof import("../../src/gateway/server-broadcast.js") =
  await import(loadedBroadcastUrl);
const { GatewayClientRegistry } = await import("../../src/gateway/server/client-registry.js");
ownerHook.deregister();
const deliveryOwner = path.resolve(values["delivery-owner"]);
const { ConnectionSessionRows }: typeof import("../../src/gateway/session-ancestor-references.js") =
  await import(pathToFileURL(deliveryOwner).href);
fieldsHook.deregister();
const fields = Object.fromEntries(
  `createdActor owner participants participantCount visibility channel subject groupChannel space
   chatType origin archived archivedAt archivedBy archiveReason pinned sidebarRoot pinnedAt
   snoozedUntil snoozedAt unread lastReadAt markedUnreadAt agentStatus observerDigest lastActivityAt
   spawnedBy controlOwnerSessionKey swarmGroupId spawnedWorkspaceDir spawnedCwd deviceFolder
   permissionMode communication effectiveCommunication permissionModePending sessionRoot forkedFromParent
   spawnDepth subagentRole subagentControlScope createdVia createdAt forkSource previousSessionId label
   autoLabel icon color channelAvatarUrl category boardPresentation displayName titlePending
   lastAssistantMessage deliveryContext parentSessionKey childSessions thinkingLevel cyberAccessProgram
   fastMode effectiveFastMode effectiveFastModeSource fastAutoOnSeconds toolOverrides verboseLevel
   traceLevel reasoningLevel reasoningDefault elevatedLevel sendPolicy systemSent abortedLastRun
   restartRecoveryStatus restartRecoveryCycleId inputTokens outputTokens usageReport lastChannel lastTo
   lastAccountId lastThreadId totalTokens totalTokensFresh goal contextTokens contextBudgetStatus
   estimatedCostUsd responseUsage effectiveResponseUsage modelProvider model activeModelProvider
   activeModel modelOverrideSource agentRuntime runtimeSelectionLocked status lastRunError
   suppressErrorNotice providerReview lastRunId hasAutomation startedAt endedAt`
    .trim()
    .split(/\s+/)
    .map((name) => [name, null]),
);
// Optional row fields are absent while the event envelope carries null tombstones.
const rowFields = freezeTrustedJsonSnapshot({
  createdActor: { type: "human", id: "synthetic-profile" },
  participantCount: 0,
  channel: "webchat",
  subject: "Synthetic task",
  chatType: "direct",
  archived: false,
  pinned: false,
  sidebarRoot: false,
  unread: false,
  lastReadAt: 1,
  lastActivityAt: 1,
  spawnedBy: "agent:main:parent",
  parentSessionKey: "agent:main:parent",
  controlOwnerSessionKey: "agent:main:parent",
  spawnedWorkspaceDir: "/synthetic/workspace",
  spawnedCwd: "/synthetic/workspace",
  permissionMode: "workspace",
  permissionModePending: false,
  sessionRoot: "/synthetic/workspace",
  forkedFromParent: false,
  spawnDepth: 1,
  subagentRole: "leaf",
  subagentControlScope: "none",
  createdVia: "spawn",
  createdAt: 1,
  autoLabel: "Synthetic task",
  icon: "chat",
  color: "blue",
  category: "task",
  boardPresentation: "split",
  displayName: "Synthetic task",
  titlePending: false,
  thinkingLevel: "off",
  verboseLevel: "off",
  traceLevel: "off",
  reasoningLevel: "off",
  elevatedLevel: "off",
  sendPolicy: "allow",
  systemSent: true,
  abortedLastRun: false,
  totalTokens: 3200,
  totalTokensFresh: true,
  contextTokens: 3200,
  estimatedCostUsd: 0,
  responseUsage: "off",
  effectiveResponseUsage: "off",
  modelProvider: "synthetic",
  model: "synthetic",
  status: "running",
  suppressErrorNotice: false,
  lastRunId: "synthetic-run",
  hasAutomation: false,
  activeRunIds: ["synthetic-run"],
  childSessions: ["agent:main:synthetic-child"],
  participants: [],
  lastAssistantMessage: {
    text: largeText || "Synthetic streamed progress with tool calls",
    timestamp: 1,
  },
} satisfies Partial<GatewaySessionRow>);
const materializedRows = Array.from({ length: sessions }, (_, index) =>
  freezeTrustedJsonSnapshot({
    ...rowFields,
    key: `agent:main:stream-envelope-${index}`,
    agentId: "main",
    kind: "direct" as const,
    updatedAt: 1,
    sessionId: `synthetic-session-${index}`,
    lifecycleRevision: "1",
    label: "Streaming tool turn",
  }),
);
const record = {
  entry: { sessionId: "synthetic-session", lifecycleRevision: "1" },
  materialized: { row: materializedRows[0]!, publicationIdentity: materializedRows[0]! },
};
// The fixture implements exactly the owner-facing read operations; presentation is mocked above.
const projection = {
  state: { revision: {} },
  describe: () => record,
  isCurrent: () => true,
  ancestorRows: () => [],
} as unknown as SessionRowProjection;
const peers = Array.from({ length: clients }, (_, index) => ({
  client: {
    connId: `synthetic-${index}`,
    usesSharedGatewayAuth: false,
    socket: Object.assign(new EventEmitter(), {
      readyState: 1,
      bufferedAmount: 0,
      send(
        frame: string | Buffer | SerializedGatewayFrame,
        options?: { binary: false } | ((error?: Error) => void),
        done?: (error?: Error) => void,
      ) {
        deliveries++;
        if (activeWireDigest) {
          if (typeof frame === "string" || Buffer.isBuffer(frame)) {
            activeWireDigest.update(frame);
          } else {
            for (const segment of frame.segments) {
              activeWireDigest.update(segment);
            }
          }
        }
        (typeof options === "function" ? options : done)?.();
      },
      close() {},
      terminate() {},
    }),
    connect: {
      role: "operator",
      client: { id: "openclaw-control-ui", version: "bench", platform: "bench", mode: "ui" },
      minProtocol: 3,
      maxProtocol: 3,
      scopes: ["operator.admin"],
      caps:
        (index + 1) % 10 === 0
          ? []
          : ["session-row-deltas", ...((index + 1) % 5 ? ["session-event-field-refs"] : [])],
    },
  } satisfies GatewayWsClient,
  rows: new ConnectionSessionRows(),
}));
const references = new Map<GatewayClient, InstanceType<typeof ConnectionSessionRows>>(
  peers.map((peer) => [peer.client, peer.rows]),
);
const context: Parameters<ReturnType<typeof prepareSessionEventProjection>>[3] = {
  isCurrentProjection: () => true,
  resolveAgentScope: () => ["main", "main", undefined],
  forgetAncestors: () => {},
  references: (client) => references.get(client)!,
  createRunProjector: () => () => ({ active: false }),
};
const prepare = prepareSessionEventProjection(
  projection,
  undefined,
  values["reuse-envelope"]
    ? { ancestors: [], reuseEnvelope: true, encodeMessage: true }
    : undefined,
);

let envelopeEncodings = 0;
let deliveries = 0;
let activeWireDigest: ReturnType<typeof createHash> | undefined;
let activeDigest: ReturnType<typeof createHash> | undefined;
let currentSessionEncoder: unknown;
let sessionEncodeCounts: Map<unknown, number> | undefined;
const sessionEncodeHistogram: Record<number, number> = {};
const broadcaster = createGatewayBroadcaster({
  clients: new GatewayClientRegistry(peers.map((peer) => peer.client)),
  canReceiveSessionEvent: () => true,
  prepareSessionEventProjection: (event, payload, scope) => {
    const project = prepare(event, payload, scope, context);
    const encodedPayloads = new Set<unknown>();
    return (
      project &&
      ((client) => {
        const result = project(client);
        assert(result);
        activeDigest?.update(JSON.stringify(result.payload));
        if (sessionEncodeCounts) {
          currentSessionEncoder = result.serializeSession;
        }
        if (!encodedPayloads.has(result.payload)) {
          encodedPayloads.add(result.payload);
          envelopeEncodings++;
        }
        return result;
      })
    );
  },
});
function publish(
  index: number,
  digest?: ReturnType<typeof createHash>,
  wireDigest?: ReturnType<typeof createHash>,
) {
  key = `agent:main:stream-envelope-${index % sessions}`;
  record.entry.sessionId = `synthetic-session-${index % sessions}`;
  const source = materializedRows[index % sessions]!;
  record.materialized.publicationIdentity = source;
  record.materialized.row = values["source-revisions"]
    ? freezeTrustedJsonSnapshot({
        ...source,
        lastAssistantMessage: {
          text: `${largeText || "Synthetic streamed progress with tool calls"} ${index}`,
          timestamp: index,
        },
      })
    : source;
  row = freezeTrustedJsonSnapshot({
    ...record.materialized.row,
    ...(values["fresh-fields"]
      ? {
          createdActor: { ...rowFields.createdActor },
          activeRunIds: [...rowFields.activeRunIds],
          childSessions: [...rowFields.childSessions],
          participants: [],
          lastAssistantMessage: { ...record.materialized.row.lastAssistantMessage },
        }
      : {}),
    key,
    agentId: "main",
    kind: "direct",
    updatedAt: 1,
    sessionId: record.entry.sessionId,
    lifecycleRevision: "1",
    runtimeMs: index,
    label: "Streaming tool turn",
    sharingRole: "viewer",
    visibility: "shared",
    inputTokens: 3200,
    outputTokens: index,
    startedAt: 1,
    hasActiveRun: true,
  });
  audienceRows = Array.from({ length: audiences }, (_, audience) =>
    freezeTrustedJsonSnapshot({ ...row, sharingRole: audience === 0 ? "owner" : "viewer" }),
  );
  const payload = { ...fields, ...row, sessionKey: key, session: row, reason: "send" };
  if (values["encode-envelopes"] || wireDigest) {
    activeDigest = digest;
    activeWireDigest = wireDigest;
    sessionEncodeCounts = wireDigest ? new Map() : undefined;
    broadcaster.broadcastToConnIds(
      "sessions.changed",
      payload,
      new Set(
        peers.flatMap((peer, position) =>
          index % 17 === (position % 7 < 4 ? 0 : position % 7 < 6 ? 1 : 2)
            ? []
            : [peer.client.connId],
        ),
      ),
    );
    for (const count of sessionEncodeCounts?.values() ?? []) {
      sessionEncodeHistogram[count] = (sessionEncodeHistogram[count] ?? 0) + 1;
    }
    sessionEncodeCounts = undefined;
    currentSessionEncoder = undefined;
    activeDigest = undefined;
    activeWireDigest = undefined;
  } else {
    const project = prepare(
      "sessions.changed",
      payload,
      { sessionKeys: [key], agentId: "main" },
      context,
    );
    assert(project);
    for (const [position, peer] of peers.entries()) {
      if (index % 17 === (position % 7 < 4 ? 0 : position % 7 < 6 ? 1 : 2)) {
        continue;
      }
      const result = project(peer.client);
      assert(result);
      result.delivered?.(peer.client);
      deliveries++;
    }
  }
}
for (let index = 0; index < 200; index++) {
  publish(index);
  if (values["yield-events"]) {
    await setImmediate();
  }
}
for (const peer of peers) {
  peer.rows.clear();
  peer.rows = new ConnectionSessionRows();
  references.set(peer.client, peer.rows);
}
envelopeEncodings = 0;
deliveries = 0;
global.gc?.();
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const memoryBefore = process.memoryUsage();
const publicationMs: number[] = [];
const cpuStart = process.threadCpuUsage();
const start = performance.now();
for (let index = 0; index < events; index++) {
  const publicationStart = performance.now();
  publish(index);
  publicationMs.push(performance.now() - publicationStart);
  if (values["yield-events"]) {
    await setImmediate();
  }
}
const elapsedMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuStart);
const memoryAfter = process.memoryUsage();
const sortedPublicationMs = publicationMs.toSorted((a, b) => a - b);
assert(deliveries > 0, "The measured replay must deliver frames");
const measuredEncoding = { envelopeEncodings, deliveries };
let sampledBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  if (values.profile) {
    writeFileSync(values.profile, JSON.stringify(profile));
  }
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
let memoryAfterGc: NodeJS.MemoryUsage | undefined;
if (global.gc) {
  await setImmediate();
  global.gc();
  memoryAfterGc = process.memoryUsage();
}
// Hash in a separate replay so serialization and cryptography do not mask projection savings.
for (const peer of peers) {
  peer.rows.clear();
  peer.rows = new ConnectionSessionRows();
  references.set(peer.client, peer.rows);
}
const digest = createHash("sha256");
const wireDigest = createHash("sha256");
const utf8 = { encodings: 0, bytes: 0, sessionEncodings: 0, sessionBytes: 0 };
const fromDescriptor = Object.getOwnPropertyDescriptor(Buffer, "from");
assert(fromDescriptor);
const from = Buffer.from.bind(Buffer);
Buffer.from = new Proxy(from, {
  apply(target, receiver, args) {
    if (typeof args[0] === "string") {
      utf8.encodings++;
      utf8.bytes += Buffer.byteLength(args[0]);
      const sessionOffset = args[0].indexOf('"session":');
      if (sessionOffset >= 0) {
        utf8.sessionEncodings++;
        if (sessionEncodeCounts) {
          sessionEncodeCounts.set(
            currentSessionEncoder,
            (sessionEncodeCounts.get(currentSessionEncoder) ?? 0) + 1,
          );
        }
        utf8.sessionBytes += Buffer.byteLength(args[0].slice(sessionOffset));
      }
    }
    return Reflect.apply(target, receiver, args);
  },
});
for (let index = 0; index < events; index++) {
  publish(index, digest, wireDigest);
  if (values["yield-events"]) {
    await setImmediate();
  }
}
Object.defineProperty(Buffer, "from", fromDescriptor);
console.log(
  JSON.stringify({
    owner,
    ownerSha256,
    fieldsOwnerSha256: createHash("sha256").update(fieldsSource).digest("hex"),
    deliveryOwnerSha256: createHash("sha256").update(readFileSync(deliveryOwner)).digest("hex"),
    node: process.version,
    events,
    sessionKiB,
    utf8,
    sessionEncodeHistogram,
    clients,
    audiences,
    distinctViewers: values["distinct-viewers"],
    sessions,
    freshFields: values["fresh-fields"],
    sourceRevisions: values["source-revisions"],
    yieldEvents: values["yield-events"],
    encodeEnvelopes: values["encode-envelopes"],
    reuseEnvelope: values["reuse-envelope"],
    ...measuredEncoding,
    mode: values.allocations ? "allocation" : "timing",
    elapsedMs,
    threadCpuMs: (cpu.user + cpu.system) / 1000,
    publicationSamples: publicationMs.length,
    publicationP99Ms: sortedPublicationMs[Math.floor(publicationMs.length * 0.99)],
    publicationP50Ms: sortedPublicationMs[Math.floor(publicationMs.length * 0.5)],
    publicationsOver180Ms: publicationMs.filter((ms) => ms > 180).length,
    publicationMaxMs: sortedPublicationMs.at(-1),
    sampledBytes,
    payloadDigest: digest.digest("hex"),
    wireDigest: wireDigest.digest("hex"),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    memoryBefore,
    memoryAfter,
    memoryAfterGc,
  }),
);
for (const peer of peers) {
  peer.rows.clear();
}
mock.restoreAll();
