/**
 * Day-shaped list-owner retention and conditional-response measurement (no DB/Gateway).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-list-baseline-retention-measure.ts \
 *   --clients 70 --rounds 8 --mode cpu --output .local/baselines-cpu.json
 * --module <saved-session-list-view-cache.ts> substitutes only that owner while
 * preserving canonical imports. Repeat with --clients 10/35/70 and --mode allocation (16 KiB V8 samples), in
 * AB/BA order. Reject pairs whose start/end one-minute host load exceeds 40.
 *
 * 25k synthetic rows, 22 viewers/70 connections, seven views per connection,
 * limit 200, and one changed recent row per round. Uses the real selection,
 * cache, delta encoder and frame serializer. Query/audience keys are explicit
 * fixture identities; this does not test authorization or the production key
 * builder. Presentation is synthetic immutable rows; its CPU is excluded.
 * Entry pairs and presented rows remain upstream-owned across cache.clear().
 * Actual cache retention is the post-GC heap+arrayBuffer decrease on clear,
 * outside timing; it excludes shared objects still owned by the roster.
 * Acceptance: fewer unknown-base/full responses, identical reconstructed rows
 * and conditional bytes for identical retained baselines, bounded added heap,
 * and no controlled adverse CPU/allocation change. Revisions are opaque random
 * IDs, so the cross-revision digest contains row contents, not revision tokens.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { EntryRow } from "../../src/gateway/session-row-projection-record.js";
import type { GatewaySessionRow } from "../../src/gateway/session-utils.types.js";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    clients: { type: "string", default: "70" },
    rounds: { type: "string", default: "8" },
    mode: { type: "string", default: "cpu" },
    output: { type: "string" },
  },
});
const ownerUrl = new URL("../../src/gateway/session-list-view-cache.ts", import.meta.url);
const transformed = transformSync(readFileSync(values.module ?? ownerUrl, "utf8"), {
  loader: "ts",
  format: "esm",
  target: "esnext",
}).code;
const hook = registerHooks({
  load(url, context, nextLoad) {
    return url === ownerUrl.href
      ? { format: "module", shortCircuit: true, source: transformed }
      : nextLoad(url, context);
  },
});
const { SessionListViewCache, sessionRowFactEncodingBytes } =
  await import("../../src/gateway/session-list-view-cache.js");
const { expandSessionRowFacts } =
  await import("../../packages/gateway-protocol/src/session-row-fields.js");
const { serializeGatewayFrame, serializedJsonArrayBytes } =
  await import("../../src/gateway/serialized-json.js");
const { createSessionIdentityProjection } =
  await import("../../src/gateway/session-identity-projection.js");
const { getSessionListBaseMiss } = await import("../../src/gateway/session-list-diagnostics.js");
const { captureSessionRowGeneration } = await import("../../src/gateway/session-row-identity.js");
const { shareSidebarSessionRows } = await import("../../src/gateway/session-row-presentation.js");
const { create, identity, selectionRow } =
  await import("../../src/gateway/session-row-projection-record.js");
const { createSessionRowSelection } = await import("../../src/gateway/session-row-selection.js");
const { sessionRowEncodingBytes } = await import("../../src/gateway/session-row-serialization.js");
const { selectSessionEntries } = await import("../../src/gateway/session-utils-list.js");
const { buildSessionListRowMetadataContext } =
  await import("../../src/gateway/session-utils-projection.js");
const { onTrustedInternalDiagnosticEvent, waitForDiagnosticEventsDrained } =
  await import("../../src/infra/diagnostic-events.js");
const { buildSubagentSessionListReadIndex } =
  await import("../../src/agents/subagents/registry/subagent-registry-read.js");
hook.deregister();
const clients = Number(values.clients);
const rounds = Number(values.rounds);
assert(Number.isSafeInteger(clients) && clients > 0 && clients <= 70);
assert(Number.isSafeInteger(rounds) && rounds > 0);
assert(values.mode === "cpu" || values.mode === "allocation");
assert(globalThis.gc, "Run with --expose-gc for retained-heap attribution");
const viewers = Math.ceil((clients * 22) / 70);
const now = 1_800_000_000_000;
const cfg = { agents: { entries: { main: {} } } };
const agents = new Set(["main"]);
const storePath = "/synthetic/list-baselines.sqlite";
const context = buildSessionListRowMetadataContext({
  now,
  subagentRuns: buildSubagentSessionListReadIndex(now, [], new Map()),
});
context.identityProjection = createSessionIdentityProjection();
for (let index = 0; index < 22; index++) {
  const id = `viewer-${index}`;
  context.userProfileIdentityById.set(id, {
    kind: "resolved",
    profileId: id,
    label: id,
    avatarUrl: `/synthetic/avatar/${id}`,
  });
}
const selection = createSessionRowSelection(
  cfg,
  {
    agentId: "main",
    path: storePath,
    paths: new Map([[storePath, 0]]),
    configuredAgentIds: agents,
    ownerAgentIds: agents,
  },
  false,
  () => context,
);
const rows = new Map<string, EntryRow>();
const presented = new Map<string, GatewaySessionRow>();
function put(index: number, updatedAt: number) {
  const key = `agent:main:baseline-${index}`;
  const entry = {
    sessionId: String(index),
    updatedAt,
    label: `Synthetic conversation ${index}`,
    archivedAt: Math.floor(index / 22) % 2 === 0 ? now - 1 : undefined,
    spawnedBy: `agent:main:parent-${index % 22}`,
    createdActor: {
      type: "human" as const,
      source: "profile" as const,
      id: `viewer-${index % 22}`,
    },
  };
  const row: EntryRow = {
    ...create({ key, agentId: "main", storeTarget: { agentId: "main", storePath } }, entry),
    entry,
  };
  rows.set(key, row);
  selection.change({
    kind: "row",
    id: identity(row),
    key,
    agentId: "main",
    row: selectionRow(row),
    scope: "session-entry",
  });
  presented.set(
    key,
    Object.freeze({
      key,
      kind: "direct",
      sessionId: entry.sessionId,
      rowMode: undefined,
      updatedAt,
      label: entry.label,
      visibility: "shared",
      pinned: false,
      hasActiveRun: false,
      childOwnerSessionKeys: [entry.spawnedBy],
    }),
  );
}
for (let index = 0; index < 25_000; index++) {
  put(index, now + index);
}
const queryMix = (viewer: string): SessionsListParams[] => [
  { rowMode: "sidebar", source: "sidebar", limit: 200, ownerFirst: true },
  { rowMode: "sidebar", source: "sidebar", limit: 200, ownerId: viewer },
  { rowMode: "sidebar", source: "sidebar", limit: 200, involvingMe: true },
  {
    rowMode: "sidebar",
    source: "sidebar",
    limit: 200,
    spawnedBy: `agent:main:parent-${viewer.slice(7)}`,
  },
  { rowMode: "compact", source: "chat-pane", limit: 200, archived: "all" },
  { rowMode: "sidebar", source: "agent-roster", limit: 200, archived: "all", excludeDock: true },
  {
    rowMode: "compact",
    source: "sessions-page",
    limit: 200,
    archived: "all",
    excludeDock: true,
    includeGlobal: true,
    includeUnknown: true,
  },
];
const cache = new SessionListViewCache();
const queries = Array.from({ length: clients }, (_, connection) => {
  const viewer = `viewer-${connection % viewers}`;
  return queryMix(viewer).map((opts) => {
    const { source: _source, rowMode: _rowMode, ...selectionOptions } = opts;
    return {
      viewer,
      opts,
      selectionKey: JSON.stringify([viewer, selectionOptions]),
      rowKey: JSON.stringify([viewer, selectionOptions, opts.rowMode]),
      revision: "",
    };
  });
});
type Query = (typeof queries)[number][number];
const declaredKeys = new Set(
  queries
    .flat()
    .flatMap((query) =>
      query.opts.spawnedBy ? [query.rowKey] : [query.selectionKey, query.rowKey],
    ),
);
const retirements: Record<string, number> = {};
let estimatedBytes = 0;
let retainedViews = 0;
const stop = onTrustedInternalDiagnosticEvent((event) => {
  if (event.type === "sessions.list.baseline.retired") {
    retirements[event.cause] = (retirements[event.cause] ?? 0) + 1;
  }
  if (event.type === "sessions.list.retention") {
    estimatedBytes = event.estimatedBytes;
    retainedViews = event.views;
  }
});
const flush = async () => {
  await setImmediate();
  await waitForDiagnosticEventsDrained();
};
const collect = async () => {
  for (let pass = 0; pass < 3; pass++) {
    await flush();
    globalThis.gc!();
  }
};
function selected(query: Query, retain: boolean) {
  const view = retain && !query.opts.spawnedBy ? cache.get(query.selectionKey) : undefined;
  if (view?.selection) {
    return view.selection;
  }
  const source = selection.read("updatedAt");
  const result = selectSessionEntries({
    cfg,
    opts: query.opts,
    now,
    entries: source.entries,
    entriesSorted: true,
    partitions: source.partitions,
    retained: view ? cache.partitions(view) : undefined,
    getTarget: source.get,
    involvementKeys: source.involvementKeys,
    configuredAgentIds: agents,
    getRowContext: () => context,
    userProfileIdentityById: context.userProfileIdentityById,
    involvingActorId: query.opts.involvingMe ? query.viewer : undefined,
    ownerFirstActorId: query.opts.ownerFirst ? query.viewer : undefined,
  });
  if (view) {
    view.selection = result;
    cache.update(view);
  }
  return result;
}
function read(query: Query) {
  const result = selected(query, true);
  const current = result.entries.map(([key]) => presented.get(key)!);
  const view = cache.get(query.rowKey);
  const previous = view.rows;
  if (
    previous?.length !== current.length ||
    current.some((row, index) => row !== previous[index])
  ) {
    const full = shareSidebarSessionRows(current);
    cache.setRows(
      view,
      current,
      true,
      full.sessions.reduce((sum, row) => sum + sessionRowEncodingBytes(row), 0) +
        serializedJsonArrayBytes(full.sessions),
      sessionRowFactEncodingBytes,
    );
  }
  const reply = shareSidebarSessionRows(
    view.rows!,
    query.revision ? `delta:${query.revision}` : undefined,
    view.rowHistory,
  );
  query.revision = reply.rowsRevision!;
  return reply;
}
function churn(round: number) {
  const index = 24_991 - (round % 22);
  put(index, now + 25_000 + round);
  const key = `agent:main:baseline-${index}`;
  for (const view of cache.values()) {
    view.selection = undefined;
    if (view.rows?.some((row) => row.key === key)) {
      cache.retireRows(view);
    } else {
      cache.update(view);
    }
  }
}
const frame = (reply: ReturnType<typeof shareSidebarSessionRows>) =>
  serializeGatewayFrame({ type: "res", id: "list", ok: true, payload: reply });
const inspector = values.mode === "allocation" ? new Session() : undefined;
try {
  for (const connection of queries) {
    for (const query of connection) {
      read(query);
    }
  }
  await collect();
  for (const cause of Object.keys(retirements)) {
    delete retirements[cause];
  }
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16_384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const misses: Record<string, number> = {};
  let wireBytes = 0,
    fullResponses = 0,
    deltas = 0,
    unchanged = 0;
  const hostLoadBefore = loadavg();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let round = 0; round < rounds; round++) {
    churn(round);
    for (const connection of queries) {
      for (const query of connection) {
        const reply = read(query);
        const miss = getSessionListBaseMiss(reply);
        if (miss) {
          misses[miss] = (misses[miss] ?? 0) + 1;
        }
        if (reply.rowsUnchanged) {
          unchanged++;
        } else if (reply.rowsDelta) {
          deltas++;
        } else {
          fullResponses++;
        }
        const encoded = frame(reply);
        wireBytes += typeof encoded === "string" ? Buffer.byteLength(encoded) : encoded.byteLength;
      }
    }
    await flush();
  }
  const elapsedMs = performance.now() - started;
  const cpuDelta = process.cpuUsage(cpu);
  const hostLoadAfter = loadavg();
  const sampledAllocatedBytes = inspector
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, sample) => sum + sample.size,
        0,
      )
    : null;
  await collect();
  const retained = process.memoryUsage();
  const finalEstimatedBytes = estimatedBytes,
    finalRetainedViews = retainedViews;
  const measuredRetirements = { ...retirements };
  let selectionPairRefs = 0,
    selectionFacetRefs = 0,
    partitions = 0;
  for (const view of cache.values()) {
    const selections = [
      ...(view.partitions?.values() ?? []),
      ...(view.selection ? [view.selection] : []),
    ];
    partitions += view.partitions?.size ?? 0;
    for (const value of selections) {
      selectionPairRefs +=
        value.entries.length + ("ownerEntries" in value ? value.ownerEntries.length : 0);
      selectionFacetRefs +=
        value.ownerFacet.length +
        (value.ownerSessionCounts?.length ?? 0) +
        (value.ownerSessionProfiles?.size ?? 0) +
        (value.people?.length ?? 0);
    }
  }
  cache.clear();
  await collect();
  const cleared = process.memoryUsage();
  const digest = createHash("sha256");
  let differentialCases = 0;
  // Independent fresh selection checks are outside the measured/cache-retention window.
  for (const query of queries[0]!) {
    const fresh = selected(query, false).entries.map(([key]) => presented.get(key)!);
    const response = read(query);
    assert.deepEqual(expandSessionRowFacts(response.sessions, response.sharedFacts), fresh);
    const base = captureSessionRowGeneration(cache.get(query.rowKey).rows!);
    const changed = fresh.length
      ? [{ ...fresh[0]!, label: "Differential change" }, ...fresh.slice(1)]
      : fresh;
    const view = cache.get(query.rowKey);
    cache.setRows(view, changed, true);
    for (const token of [base.revision, `delta:${base.revision}`, "delta:unknown"]) {
      assert.equal(
        frame(shareSidebarSessionRows(changed, token, view.rowHistory)).toString(),
        frame(shareSidebarSessionRows(changed, token, [base])).toString(),
      );
      differentialCases++;
    }
    digest.update(JSON.stringify(fresh));
  }
  const output = JSON.stringify(
    {
      mode: values.mode,
      clients,
      viewers,
      viewsPerClient: 7,
      distinctKeys: declaredKeys.size,
      corpusRows: rows.size,
      rounds,
      listReads: clients * 7 * rounds,
      misses,
      fullResponses,
      deltas,
      unchanged,
      retirements: measuredRetirements,
      selectionPairRefs,
      selectionFacetRefs,
      partitions,
      wireBytes,
      finalEstimatedBytes,
      finalRetainedViews,
      retainedHeapBytes: retained.heapUsed - cleared.heapUsed,
      retainedArrayBufferBytes: retained.arrayBuffers - cleared.arrayBuffers,
      heapBeforeClear: retained.heapUsed,
      heapAfterClear: cleared.heapUsed,
      cpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
      elapsedMs,
      sampledAllocatedBytes,
      differentialCases,
      finalRowsDigest: digest.digest("hex"),
      hostLoadBefore,
      hostLoadAfter,
    },
    null,
    2,
  );
  if (values.output) {
    writeFileSync(values.output, output + "\n");
  }
  console.log(output);
} finally {
  inspector?.disconnect();
  stop();
  cache.clear();
}
