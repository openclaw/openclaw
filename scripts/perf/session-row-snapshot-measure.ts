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
 * --cpu-profile <file> captures a separate iteration-window CPU profile.
 * Node 24+; no V8-version-specific allocation counter is required.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
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
    rows: { type: "string", default: "500" },
    churn: { type: "string", default: "1" },
    parents: { type: "string", default: "0" },
    allocation: { type: "boolean", default: false },
    "cpu-profile": { type: "string" },
    warmup: { type: "string", default: "100" },
    iterations: { type: "string", default: "1000" },
  },
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
function mutate(sequence: number) {
  for (let index = 0; index < churn; index++) {
    const query = queries[(sequence + index) % queries.length]!;
    const record = rows.get(query.key)!;
    record.materialized = replaceSessionRowFacts(record.materialized, {
      label: `Synthetic ${sequence}:${index}`,
    });
  }
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
    mutate(index);
    snapshot();
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
  let cpuUs = 0;
  let wallMs = 0;
  for (let index = 0; index < iterations; index++) {
    mutate(index);
    const cpuStart = process.threadCpuUsage();
    const start = performance.now();
    snapshot();
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
  samples.sort((a, b) => a - b);
  assert.equal(projections, iterations * churn);
  console.log(
    JSON.stringify({
      workload: "publication-snapshot-cache",
      node: process.version,
      parentCount,
      rowCount,
      mode: values.allocation ? "allocation" : values["cpu-profile"] ? "cpu-profile" : "timing",
      coldWallMs,
      medianPageMs: samples[Math.floor(samples.length / 2)],
      p95PageMs: samples[Math.ceil(samples.length * 0.95) - 1],
      maxPageMs: samples.at(-1),
      churn,
      iterations,
      warmup,
      snapshots: rowCount * iterations,
      projections,
      cpuUsPerPage: cpuUs / iterations,
      cpuUsPerSnapshot: cpuUs / iterations / rowCount,
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
  metadata.dispose();
}
