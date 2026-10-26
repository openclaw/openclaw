/**
 * Session event owner microbenchmark: 65 recipients, staggered histories, row deltas,
 * field references and legacy envelopes. Synthetic prepared rows replace only the
 * presentation boundary; the actual event projector and delivery planner run unchanged.
 * The diagnostic sink is inert and access revision fixed; retention accounting still runs.
 * This measures owner CPU/allocation, not authorization or whole-Gateway latency.
 *
 * node --expose-gc --experimental-test-module-mocks --import ./scripts/tsx.mjs \
 *   scripts/perf/session-event-envelope-measure.ts --events 3000
 * Add --owner src/gateway/.baseline.ts for a saved source sibling, --delivery-owner
 * src/gateway/.delivery-baseline.ts to compare delta preparation, and --allocations
 * for a separate sampled-allocation pass. Alternate baseline/candidate timing and
 * allocation runs. Acceptance: identical payload digest, lower allocation and CPU;
 * report absolute costs and spread, and do not infer whole-Gateway tail changes.
 * --audiences selects distinct prepared row identities (default 2); use 8 with 65
 * clients to measure reuse within interleaved audiences rather than across all clients.
 * --fresh-fields replaces every nested field per event to measure misses separately.
 * --profile <path> saves the sampled profile when used with --allocations.
 * Add --no-turbo-inlining to Node for callee attribution. Compare --clients 1/10/60
 * with --audiences 1/8/8 to distinguish single-recipient and audience fanout costs.
 * --sessions 64 rotates changing rows through the connection-owned delivery histories.
 * --encode-envelopes includes JSON encoding once per distinct projected payload,
 * checking object-shape costs as well as projection; it does not measure transport.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import type { SessionRowProjection } from "../../src/gateway/session-row-projection.js";
import type { GatewaySessionRow } from "../../src/gateway/session-utils.types.js";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/gateway/session-event-projection.ts" },
    "delivery-owner": { type: "string", default: "src/gateway/session-ancestor-references.ts" },
    events: { type: "string", default: "3000" },
    clients: { type: "string", default: "65" },
    audiences: { type: "string", default: "2" },
    sessions: { type: "string", default: "1" },
    allocations: { type: "boolean", default: false },
    profile: { type: "string" },
    "encode-envelopes": { type: "boolean", default: false },
    "fresh-fields": { type: "boolean", default: false },
  },
});
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
let key = "agent:main:stream-envelope";
let row: GatewaySessionRow;
let audienceRows: GatewaySessionRow[];
mock.module(new URL("../../src/gateway/session-row-presentation.ts", import.meta.url), {
  namedExports: {
    prepareSessionRowPublication: () => (client: GatewayClient) => ({
      getAudienceKey: () => client.connect.scopes?.[0] ?? "viewer",
      getPresentation: () => ({
        present: () => audienceRows[Number(client.connect.scopes![0])],
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
mock.module(new URL("../../src/infra/diagnostic-events.ts", import.meta.url), {
  namedExports: { emitTrustedDiagnosticEvent: () => {} },
});
mock.module(new URL("../../src/gateway/gateway-access-revision.ts", import.meta.url), {
  namedExports: { readGatewayAccessRevision: () => 0 },
});
const {
  prepareSessionEventProjection,
}: typeof import("../../src/gateway/session-event-projection.js") = await import(
  pathToFileURL(owner).href
);
const deliveryOwner = path.resolve(values["delivery-owner"]);
const { ConnectionSessionRows }: typeof import("../../src/gateway/session-ancestor-references.js") =
  await import(pathToFileURL(deliveryOwner).href);
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
  lastAssistantMessage: { text: "Synthetic streamed progress with tool calls", timestamp: 1 },
} satisfies Partial<GatewaySessionRow>);
const record = { entry: { sessionId: "synthetic-session", lifecycleRevision: "1" } };
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
    connect: {
      client: { id: "openclaw-control-ui", version: "bench", platform: "bench", mode: "ui" },
      minProtocol: 3,
      maxProtocol: 3,
      scopes: [String(index % audiences)],
      caps:
        (index + 1) % 10 === 0
          ? []
          : ["session-row-deltas", ...((index + 1) % 5 ? ["session-event-field-refs"] : [])],
    },
  } satisfies GatewayClient,
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
const prepare = prepareSessionEventProjection(projection);
let envelopeEncodings = 0;
let envelopeBytes = 0;
function publish(index: number, digest?: ReturnType<typeof createHash>) {
  key = `agent:main:stream-envelope-${index % sessions}`;
  record.entry.sessionId = `synthetic-session-${index % sessions}`;
  row = freezeTrustedJsonSnapshot({
    ...rowFields,
    ...(values["fresh-fields"]
      ? {
          createdActor: { ...rowFields.createdActor },
          activeRunIds: [...rowFields.activeRunIds],
          childSessions: [...rowFields.childSessions],
          participants: [],
          lastAssistantMessage: { ...rowFields.lastAssistantMessage },
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
  const project = prepare(
    "sessions.changed",
    { ...fields, ...row, sessionKey: key, session: row, reason: "send" },
    { sessionKeys: [key], agentId: "main" },
    context,
  );
  assert(project);
  const encodedPayloads = values["encode-envelopes"] ? new Set<unknown>() : undefined;
  for (const [position, peer] of peers.entries()) {
    // Staggered delivery creates distinct live histories without growing the recipient set.
    if (index % 17 === position % 17) {
      continue;
    }
    const result = project(peer.client);
    assert(result);
    if (encodedPayloads && !encodedPayloads.has(result.payload)) {
      encodedPayloads.add(result.payload);
      envelopeBytes += Buffer.byteLength(JSON.stringify({ payload: result.payload }));
      envelopeEncodings++;
    }
    digest?.update(JSON.stringify(result.payload));
    result.delivered?.(peer.client);
  }
}
for (let index = 0; index < 200; index++) {
  publish(index);
}
for (const peer of peers) {
  peer.rows.clear();
}
envelopeEncodings = 0;
envelopeBytes = 0;
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
const cpuStart = process.threadCpuUsage();
const start = performance.now();
for (let index = 0; index < events; index++) {
  publish(index);
}
const elapsedMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuStart);
const memoryAfter = process.memoryUsage();
const measuredEncoding = { envelopeEncodings, envelopeBytes };
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
// Hash in a separate replay so serialization and cryptography do not mask projection savings.
for (const peer of peers) {
  peer.rows.clear();
}
const digest = createHash("sha256");
for (let index = 0; index < events; index++) {
  publish(index, digest);
}
console.log(
  JSON.stringify({
    owner,
    ownerSha256,
    deliveryOwnerSha256: createHash("sha256").update(readFileSync(deliveryOwner)).digest("hex"),
    node: process.version,
    events,
    clients,
    audiences,
    sessions,
    freshFields: values["fresh-fields"],
    encodeEnvelopes: values["encode-envelopes"],
    ...measuredEncoding,
    mode: values.allocations ? "allocation" : "timing",
    elapsedMs,
    threadCpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    payloadDigest: digest.digest("hex"),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    memoryBefore,
    memoryAfter,
  }),
);
for (const peer of peers) {
  peer.rows.clear();
}
mock.restoreAll();
