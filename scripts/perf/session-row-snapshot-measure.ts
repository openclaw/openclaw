/**
 * Measure the existing publication snapshot cache with synthetic materialized rows.
 * node --import ./scripts/tsx.mjs scripts/perf/session-row-snapshot-measure.ts \
 *   --rows 500 --churn 1 --iterations 1000
 * Rows are prepared outside each measured page; churn replaces materialized identity.
 * The real presenter, run-state, child-activity, row projection and publication maps
 * run unchanged. No Gateway/database/provider: these are owner-only measurements.
 * Checks prove warm pages reproject exactly the changed rows and preserve unaffected
 * row identities. Compare 50/500/2000 rows with --churn 0, 1 and the row count.
 * CPU and exact V8 allocated bytes cover snapshot loops, excluding fixture mutation.
 */
import assert from "node:assert/strict";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
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
import {
  materializeSessionRow,
  readSessionRowInputs,
  replaceSessionRowFacts,
} from "../../src/gateway/session-utils-row.js";
import type { GatewaySessionRow } from "../../src/gateway/session-utils.types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    rows: { type: "string", default: "500" },
    churn: { type: "string", default: "1" },
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
assert(churn <= rowCount);
const now = 1_800_000_000_000;
const cfg: OpenClawConfig = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
const metadata = createSessionRowProjectionContext({
  snapshotIdentity: () => cfg,
  runs: () => new Map(),
  prepare: async () => {},
});
const rows = new Map<string, records.MaterializedRow>();
for (let index = 0; index < rowCount; index++) {
  const key = `agent:main:subagent:synthetic-${index}`;
  const entry = {
    sessionId: `synthetic-${index}`,
    updatedAt: 1,
    status: "done" as const,
    spawnedBy: "agent:main:parent",
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
const activity = createSessionRowChildActivity(() => []);
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
try {
  snapshot();
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
  for (let index = 0; index < Math.max(100, Math.ceil(50_000 / rowCount)); index++) {
    mutate(index);
    snapshot();
  }
  const loadBefore = loadavg();
  projections = 0;
  let allocatedBytes = 0;
  let cpuUs = 0;
  let wallMs = 0;
  for (let index = 0; index < iterations; index++) {
    mutate(index);
    const allocationStart = getHeapStatistics().total_allocated_bytes;
    assert(Number.isFinite(allocationStart));
    const cpuStart = process.threadCpuUsage();
    const start = performance.now();
    snapshot();
    wallMs += performance.now() - start;
    const cpu = process.threadCpuUsage(cpuStart);
    cpuUs += cpu.user + cpu.system;
    allocatedBytes += getHeapStatistics().total_allocated_bytes - allocationStart;
  }
  assert.equal(projections, iterations * churn);
  console.log(
    JSON.stringify({
      workload: "publication-snapshot-cache",
      rowCount,
      churn,
      iterations,
      snapshots: rowCount * iterations,
      projections,
      cpuUsPerPage: cpuUs / iterations,
      cpuUsPerSnapshot: cpuUs / iterations / rowCount,
      allocationBytesPerPage: allocatedBytes / iterations,
      allocationBytesPerSnapshot: allocatedBytes / iterations / rowCount,
      wallMs,
      hostLoadBefore: loadBefore,
      hostLoadAfter: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  metadata.dispose();
}
