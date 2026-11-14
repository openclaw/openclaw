/**
 * Measure the existing publication snapshot cache with synthetic materialized rows.
 * node --import ./scripts/tsx.mjs scripts/perf/session-row-snapshot-measure.ts \
 *   --rows 500 --churn 1 --iterations 1000
 * Rows are prepared outside each measured page; churn replaces materialized identity.
 * The real presenter, run-state, child-activity, row projection and publication maps
 * run unchanged. No Gateway/database/provider: these are owner-only measurements.
 * Checks prove warm pages reproject exactly the changed rows and preserve unaffected
 * row identities. Compare 50/500/2000 rows with --churn 0, 1 and the row count.
 * --parents 2800 --rows 14000 adds resident parents and four children per parent.
 * CPU/wall cover snapshot loops only; --allocation samples the whole iteration,
 * including fixture mutation. Run allocation separately from untraced timing.
 * clockViews counts subagent clock-view construction, including the one page presenter.
 * Page tails/stalls cover owner snapshots only, not Gateway consume tasks or RPC latency.
 * --cpu-profile <file> captures a separate iteration-window CPU profile.
 * --recipients 70 exercises the actual recap producer and broadcaster with 70 inert
 * socket sinks, 40 sidebar/20 dashboard/10 detail histories, and 12 rotating recaps
 * (--churn 12). Use --rows 15800 --parents 3160. Timers advance virtually; timing
 * covers the prepared synchronous consume only. Storage reads/recipient admission
 * are fixture boundaries; presentation, histories, field references and encoding run
 * unchanged. Digest replay strips random ancestor certificates, outside measurement.
 * Physical compression, networking and whole-Gateway load are not measured.
 * Node 24+; no V8-version-specific allocation counter is required.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { mock } from "node:test";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { SerializedGatewayFrame } from "../../src/gateway/serialized-json.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import type { GatewayWsClient } from "../../src/gateway/server/ws-types.js";
import { prepareSessionFastModePresentation } from "../../src/gateway/session-fast-mode-presentation.js";
import { SessionListViewCache } from "../../src/gateway/session-list-view-cache.js";
import { createSessionRowChildActivity } from "../../src/gateway/session-row-child-activity.js";
import { createSessionRowChildVisibility } from "../../src/gateway/session-row-child-visibility.js";
import type { SessionRowReadView } from "../../src/gateway/session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "../../src/gateway/session-row-presentation.js";
import { createSessionRowProjectionContext } from "../../src/gateway/session-row-projection-context.js";
import * as records from "../../src/gateway/session-row-projection-record.js";
import { prepareProjectedSessionSharing } from "../../src/gateway/session-sharing.js";
import { projectSessionRowChildLinks } from "../../src/gateway/session-utils-projection.js";
import {
  materializeSessionRow,
  readSessionRowInputs,
  replaceSessionRowFacts,
} from "../../src/gateway/session-utils-row.js";
import type { GatewaySessionRow } from "../../src/gateway/session-utils.types.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    corpus: { type: "string" },
    recipients: { type: "string", default: "0" },
    rows: { type: "string", default: "500" },
    churn: { type: "string", default: "1" },
    parents: { type: "string", default: "0" },
    allocation: { type: "boolean", default: false },
    "cpu-profile": { type: "string" },
    warmup: { type: "string", default: "100" },
    iterations: { type: "string", default: "1000" },
  },
});
const recipientCount = parseStrictIntegerOption({
  raw: values.recipients,
  label: "recipients",
  min: 0,
  fallback: 0,
});
const rowCount = parseStrictIntegerOption({
  raw: values.rows,
  label: "rows",
  min: 1,
  fallback: 500,
});
const churn = parseStrictIntegerOption({ raw: values.churn, label: "churn", min: 0, fallback: 1 });
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 1000,
});
const parentCount = parseStrictIntegerOption({
  raw: values.parents,
  label: "parents",
  min: 0,
  fallback: 0,
});
const warmup = parseStrictIntegerOption({
  raw: values.warmup,
  label: "warmup",
  min: 1,
  fallback: 100,
});
assert(!(values.allocation && values["cpu-profile"]), "Separate CPU and heap profiling");
assert(churn <= rowCount);
assert(parentCount * 2 <= rowCount, "Each parent needs at least one child");
const now = 1_800_000_000_000;
const cfg: OpenClawConfig = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
const metadata = createSessionRowProjectionContext(
  {
    snapshotIdentity: () => cfg,
    runs: () => new Map(),
    prepare: async () => {},
  },
  {
    state: () => ({ cfg, epoch: 0, disposed: false }),
    prepareRegistry: () => undefined,
  },
);
const rows = new Map<string, records.MaterializedRow>();
for (let index = 0; index < rowCount; index++) {
  const key = `agent:main:${index < parentCount ? "dashboard" : "subagent"}:synthetic-${index}`;
  const entry = {
    sessionId: `synthetic-${index}`,
    updatedAt: 1,
    status: "done" as const,
    spawnedBy:
      index < parentCount
        ? undefined
        : parentCount
          ? `agent:main:dashboard:synthetic-${(index - parentCount) % parentCount}`
          : "agent:main:parent",
  };
  const target = {
    key,
    agentId: "main",
    storeTarget: { agentId: "main", storePath: "/synthetic/main.sqlite" },
  };
  const { inputs } = readSessionRowInputs({
    cfg,
    key,
    agentId: "main",
    entry,
    store: {},
    storePath: target.storeTarget.storePath,
    rowContext: metadata.current,
    active: false,
    activeModel: null,
    terminalModel: null,
    preparedAcpMeta: null,
    preparedRuntimeOwnership: null,
    preparedModelMetadata: null,
    preparedRepositoryWorkspace: null,
    lightweightListRow: true,
    skipTranscriptUsageFallback: true,
    now,
  });
  rows.set(key, {
    ...records.create(target, entry),
    entry,
    materialized: materializeSessionRow(inputs),
  });
}
const children = new Map<string, records.MaterializedRow[]>();
for (const row of rows.values()) {
  const parent = row.entry.spawnedBy;
  if (parent && rows.has(parent)) {
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }
}
for (const row of rows.values()) {
  row.parents = records.readSessionRowParents(row, row.entry, cfg, metadata.current);
  const childLinks = projectSessionRowChildLinks(children.get(row.key) ?? []);
  row.materialized = replaceSessionRowFacts(row.materialized, undefined, { childLinks });
}
assert.equal(children.size, parentCount);
const activity = createSessionRowChildActivity(
  (link) => rows.get(link.key)?.materialized.source.childLinks ?? [],
);
let clockViews = 0;
const atTime = metadata.current.subagentRuns.atTime.bind(metadata.current.subagentRuns);
metadata.current.subagentRuns.atTime = (...args) => {
  clockViews++;
  return atTime(...args);
};
const visibility = createSessionRowChildVisibility();
let projections = 0;
const read: SessionRowReadView = {
  state: { cfg, policyConfig: cfg, rowContext: metadata.current },
  describe: (query) => rows.get(query.key),
  readSource: () => undefined,
  readMembership: () => undefined,
  readChildVisibility: (...args) => visibility.read(...args),
  readChildActivity: (record, clock, excluded, revision) =>
    activity.read(record, metadata.current, clock, excluded, revision),
  present: (record, options) => {
    projections++;
    return records.present(record, metadata.current, options);
  },
  selectEntries: () => [],
  physicalPaths: () => [],
};
const publication: NonNullable<
  Parameters<typeof prepareProjectedSessionPresentation>[4]
>["publicationState"] = {
  factsRevision: 0,
  rows: new WeakMap(),
  previousViews: new WeakMap(),
  lists: new SessionListViewCache(),
};
const recipient = {
  ...read.state,
  presentFastMode: prepareSessionFastModePresentation(undefined),
  publicationState: publication,
  sharing: prepareProjectedSessionSharing({ cfg, client: null, isMember: () => false }),
};
const queries = [...rows.values()].map(({ key, agentId }) => ({ key, agentId }));
const options = { rowMode: "sidebar" as const };
let page: GatewaySessionRow[] = [];
const snapshot = () => {
  const presenter = prepareProjectedSessionPresentation(read, undefined, now, undefined, recipient);
  page = queries.map((query) => {
    const row = presenter.snapshot(query, options).row;
    assert(row);
    return row;
  });
};
function mutate(sequence: number, recap = false) {
  for (let index = 0; index < churn; index++) {
    const query =
      queries[
        recap
          ? parentCount + ((sequence + index) % Math.max(1, churn))
          : (sequence + index) % queries.length
      ]!;
    const record = rows.get(query.key)!;
    record.materialized = replaceSessionRowFacts(record.materialized, {
      label: `Synthetic ${sequence}:${index}`,
    });
  }
}
// Recap mode uses the same resident rows with actual presentation, publication and
// broadcast encoding. Only prepared storage reads and physical sockets are synthetic.
let deliveredFrames = 0;
const digest = createHash("sha256");
if (values.corpus) {
  writeFileSync(values.corpus, "");
}
let verifyFrames = false;
let consumeCpuUs = 0;
let consumeWallMs = 0;
let consumeSamples: number[] = [];
let summarize: ((sequence: number) => Promise<void>) | undefined;
let disposeSummary: (() => void) | undefined;
if (recipientCount) {
  const { createSessionRowProjectionFixture } =
    await import("../../src/gateway/session-row-projection.test-support.js");
  const { broadcastSessionActivitySummary } =
    await import("../../src/gateway/session-activity-summary-events.js");
  const { createGatewayBroadcaster } = await import("../../src/gateway/server-broadcast.js");
  const { GatewayClientRegistry } = await import("../../src/gateway/server/client-registry.js");
  const { createSessionRowDeltaDiffer } =
    await import("../../src/gateway/session-row-delta-fields.js");
  const { ConnectionSessionRows } =
    await import("../../src/gateway/session-ancestor-references.js");
  const { prepareSessionRowPublication } =
    await import("../../src/gateway/session-row-presentation.js");
  const fixture = createSessionRowProjectionFixture({
    cfg,
    store: {},
    rowContext: metadata.current,
  });
  const projection = Object.assign(fixture, read, {
    state: { ...fixture.state, ...read.state },
    capture: (query: records.Lookup) => read.describe(query),
    isCurrent: (row: records.Row) => rows.get(row.key)?.generation === row.generation,
    ancestorRows: (row: records.Row) => {
      const parentKey = row.entry?.spawnedBy;
      const parent = parentKey && rows.get(parentKey);
      return parent ? [parent] : [];
    },
  });
  projection.withPreparedExactRows = async (selectQueries, consume) => {
    selectQueries(cfg);
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    const framesBefore = deliveredFrames;
    const result = consume(projection);
    const elapsed = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    if (deliveredFrames !== framesBefore) {
      consumeCpuUs += used.user + used.system;
      consumeWallMs += elapsed;
      consumeSamples.push(elapsed);
    }
    return result;
  };
  const clients = new GatewayClientRegistry();
  const histories = new Map<GatewayClient, InstanceType<typeof ConnectionSessionRows>>();
  for (let index = 0; index < recipientCount; index++) {
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      bufferedAmount: 0,
      send(
        frame: string | Buffer | SerializedGatewayFrame,
        sendOptions?: { binary: false } | ((error?: Error) => void),
        done?: (error?: Error) => void,
      ) {
        deliveredFrames++;
        if (verifyFrames) {
          const decoded: {
            payload: {
              ancestorSessions?: Array<{
                ancestorRevision?: string;
                full?: { ancestorRevision?: string };
                set?: { ancestorRevision?: string };
              }>;
              ancestorSessionRefs?: Array<{ revision?: string }>;
            };
          } = JSON.parse(frame.toString());
          for (const ancestor of decoded.payload.ancestorSessions ?? []) {
            delete ancestor.ancestorRevision;
            if (ancestor.set) {
              delete ancestor.set.ancestorRevision;
            }
            if (ancestor.full) {
              delete ancestor.full.ancestorRevision;
            }
          }
          for (const ancestor of decoded.payload.ancestorSessionRefs ?? []) {
            delete ancestor.revision;
          }
          const encoded = JSON.stringify(decoded.payload);
          if (values.corpus) {
            appendFileSync(values.corpus, `${encoded}\n`);
          }
          digest.update(encoded);
        }
        (typeof sendOptions === "function" ? sendOptions : done)?.();
      },
      close() {},
      terminate() {},
    });
    const client: GatewayWsClient = {
      connId: `synthetic-${index}`,
      socket,
      usesSharedGatewayAuth: false,
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
        scopes: ["operator.admin"],
        caps:
          index % 10 === 0
            ? []
            : ["session-row-deltas", ...(index % 5 ? ["session-event-field-refs"] : [])],
      },
    };
    clients.add(client);
    const history = new ConnectionSessionRows();
    histories.set(client, history);
    // Day-view mix: 40/70 sidebar, 20/70 dashboard, 10/70 detail, distinct windows.
    const mode = index % 7 < 4 ? "sidebar" : index % 7 < 6 ? "dashboard" : undefined;
    const presenter = prepareSessionRowPublication(projection, now)(client).getPresentation();
    const rosterPage = queries.slice(index * 100, index * 100 + (mode ? 100 : 1)).map((query) => {
      const row = presenter.snapshot(query, { rowMode: mode }).row;
      assert(row);
      return row;
    });
    const differ = createSessionRowDeltaDiffer();
    for (const row of rosterPage) {
      history.deliver(
        history.prepareDelivery(row, [], "00000000-0000-4000-8000-000000000000", differ),
      );
    }
  }
  const broadcaster = createGatewayBroadcaster({
    clients,
    canReceiveSessionEvent: () => true,
    prepareSessionEventProjection: (event, payload, scope) =>
      scope.prepareSessionProjection?.(event, payload, scope, {
        isCurrentProjection: (current) => current === projection,
        resolveAgentScope: () => ["main", "main", undefined],
        forgetAncestors: () => {},
        references: (client) => {
          const history = histories.get(client);
          assert(history);
          return history;
        },
        createRunProjector: () => () => ({ active: false }),
      }),
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  const originalNow = Date.now;
  Date.now = () => now;
  summarize = async (sequence) => {
    const query = queries[parentCount + (sequence % Math.max(1, churn))];
    assert(query);
    const record = rows.get(query.key)!;
    const work = broadcastSessionActivitySummary(
      { ...query, storePath: record.storeTarget.storePath },
      {
        getSessionRowProjection: () => projection,
        broadcast: broadcaster.broadcast,
      },
    );
    mock.timers.tick(750);
    await work;
  };
  disposeSummary = () => {
    Date.now = originalNow;
    mock.timers.reset();
    for (const history of histories.values()) {
      history.clear();
    }
    projection.dispose();
  };
}
const inspector = new Session();
try {
  const coldStart = performance.now();
  snapshot();
  const coldWallMs = performance.now() - coldStart;
  const first = page;
  projections = 0;
  snapshot();
  assert.equal(projections, 0, "Unchanged snapshots must already reuse their presentation");
  page.forEach((row, index) => assert.equal(row, first[index]));
  mutate(0);
  snapshot();
  assert.equal(projections, churn, "Only replaced materialized rows may reproject");
  for (let index = churn; index < rowCount; index++) {
    assert.equal(page[index], first[index]);
  }
  for (let index = 0; index < Math.max(warmup, Math.ceil(50_000 / rowCount)); index++) {
    mutate(index, summarize !== undefined);
    if (summarize) {
      await summarize(index);
    } else {
      snapshot();
    }
  }
  const loadBefore = loadavg();
  projections = 0;
  if (values.allocation) {
    await startCollectedHeapSampling(inspector, 8192);
  }
  if (values["cpu-profile"]) {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const samples: number[] = [];
  consumeCpuUs = 0;
  consumeWallMs = 0;
  consumeSamples = [];
  deliveredFrames = 0;
  clockViews = 0;
  let cpuUs = 0;
  let wallMs = 0;
  for (let index = 0; index < iterations; index++) {
    mutate(index, summarize !== undefined);
    const cpuStart = process.threadCpuUsage();
    const start = performance.now();
    if (summarize) {
      await summarize(index);
    } else {
      snapshot();
    }
    const elapsed = performance.now() - start;
    samples.push(elapsed);
    wallMs += elapsed;
    const cpu = process.threadCpuUsage(cpuStart);
    cpuUs += cpu.user + cpu.system;
  }
  const allocatedBytes = values.allocation
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  if (values["cpu-profile"]) {
    writeFileSync(
      values["cpu-profile"],
      JSON.stringify((await inspector.post("Profiler.stop")).profile),
    );
  }
  const measuredWork = { clockViews, projections };
  if (summarize) {
    assert.equal(consumeSamples.length, iterations);
    cpuUs = consumeCpuUs;
    wallMs = consumeWallMs;
    samples.splice(0, samples.length, ...consumeSamples);
    assert.equal(deliveredFrames, iterations * recipientCount);
    verifyFrames = true;
    for (let index = 0; index < 24; index++) {
      await summarize(index);
    }
  } else {
    assert.equal(projections, iterations * churn);
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      workload: summarize ? "activity-summary-consume" : "publication-snapshot-cache",
      recipientCount,
      payloadDigest: summarize ? digest.digest("hex") : undefined,
      consumeSamples: samples.length,
      node: process.version,
      parentCount,
      rowCount,
      mode: values.allocation ? "allocation" : values["cpu-profile"] ? "cpu-profile" : "timing",
      coldWallMs,
      medianPageMs: samples[Math.floor(samples.length / 2)],
      p95PageMs: samples[Math.ceil(samples.length * 0.95) - 1],
      p99PageMs: samples[Math.ceil(samples.length * 0.99) - 1],
      maxPageMs: samples.at(-1),
      pagesOver180Ms: samples.filter((ms) => ms > 180).length,
      ...measuredWork,
      churn,
      iterations,
      warmup,
      snapshots: summarize ? undefined : rowCount * iterations,
      cpuUsPerPage: cpuUs / iterations,
      cpuUsPerSnapshot: summarize ? undefined : cpuUs / iterations / rowCount,
      sampledAllocationBytesPerIteration:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      wallMs,
      hostLoadBefore: loadBefore,
      hostLoadAfter: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
  disposeSummary?.();
  metadata.dispose();
}
