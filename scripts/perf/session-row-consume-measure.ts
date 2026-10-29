/**
 * Owner benchmark for keyed subagent changes followed by a 100-row parent page.
 * --flow event instead consumes only the changed child and its parent.
 * 10,000 synthetic resident sessions / 100 agents; real registry read index,
 * row metadata context, relationship reader, and row materialization/presentation.
 * No Gateway, sockets, database, or model calls; this is owner evidence only.
 *
 * Save the original context and read-index modules before editing, then run:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-row-consume-measure.ts \
 *   --base-context .local/buf517/base-context.ts --base-index .local/buf517/base-index.ts
 * Omit both --base-* options for candidate. Repeat with --allocation separately;
 * alternate base/candidate then candidate/base. Default: 3,000 calls per arm.
 * Acceptance: equal verification/final digests, fewer unrelated row refreshes,
 * lower CPU/allocation per call. Setup, warmup, and byte verification are excluded.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { SubagentRunReadRecord } from "../../src/agents/subagents/registry/subagent-registry-read.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { MaterializedRow, Row } from "../../src/gateway/session-row-projection-record.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "base-context": { type: "string" },
    "base-index": { type: "string" },
    allocation: { type: "boolean", default: false },
    iterations: { type: "string", default: "3000" },
    flow: { type: "string", default: "list" },
  },
});
assert(
  Boolean(values["base-context"]) === Boolean(values["base-index"]),
  "Pass both baseline modules",
);
assert(values.flow === "list" || values.flow === "event", "--flow must be list or event");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 3000,
});
const sourceFiles = [
  [
    new URL("../../src/gateway/session-row-projection-context.ts", import.meta.url),
    values["base-context"],
  ],
  [
    new URL("../../src/agents/subagents/registry/subagent-registry-read-index.ts", import.meta.url),
    values["base-index"],
  ],
] as const;
const sources = new Map(
  sourceFiles.map(([url, override]) => [url.href, readFileSync(override ?? url, "utf8")]),
);
registerHooks({
  load(url, context, nextLoad) {
    const source = sources.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module-typescript", source, shortCircuit: true };
  },
});
const stateDir = path.resolve(".local/buf517/owner-state");
mkdirSync(stateDir, { recursive: true });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
const [
  records,
  { createSessionRowProjectionContext },
  { createSessionRowRelationReads },
  { readSessionRowInputs, materializeSessionRow },
  { publishSubagentRunChanges },
] = await Promise.all([
  import("../../src/gateway/session-row-projection-record.js"),
  import("../../src/gateway/session-row-projection-context.js"),
  import("../../src/gateway/session-row-projection-ancestors.js"),
  import("../../src/gateway/session-utils-row.js"),
  import("../../src/agents/subagents/registry/subagent-registry-publication.js"),
]);
const agents = 100;
const sessions = 10_000;
const anchor = Date.UTC(2026, 9, 27);
const actualNow = Date.now;
Date.now = () => anchor;
const cfg: OpenClawConfig = {
  agents: {
    entries: Object.fromEntries(Array.from({ length: agents }, (_, i) => [`synthetic-${i}`, {}])),
    defaults: { model: "fixture/model" },
  },
  plugins: { enabled: false },
};
const runs = new Map<string, SubagentRunReadRecord>();
let snapshot = {};
for (let index = 0; index < sessions; index++) {
  if (index % 100 === 0) {
    continue;
  }
  const agentId = `synthetic-${Math.floor(index / 100)}`;
  runs.set(`run-${index}`, {
    runId: `run-${index}`,
    childSessionKey: `agent:${agentId}:subagent:${index}`,
    requesterSessionKey: `agent:${agentId}:parent`,
    requesterAgentId: agentId,
    swarmRequesterSessionKey: `agent:${agentId}:parent`,
    collect: true,
    groupId: "group",
    createdAt: anchor - index,
    execution: { status: "terminal", startedAt: anchor - 1000, endedAt: anchor - 500 },
    collectorCompletion: { status: "done" },
  });
}
const owner = createSessionRowProjectionContext({
  snapshotIdentity: () => snapshot,
  prepare: async () => {},
  runs: (ids) =>
    ids
      ? new Map(
          [...ids].flatMap((id) => {
            const row = runs.get(id);
            return row ? [[id, row]] : [];
          }),
        )
      : new Map(runs),
});
const rows = new Map<string, Row>();
const byKey = new Map<string, Row>();
const refs = new Map<string, Row>();
const byParent = new Map<string, Set<string>>();
const dirty = new Set<string>();
const referenced = (reference: string) => refs.get(reference);
function put(row: Row) {
  const id = records.identity(row);
  const previous = rows.get(id);
  for (const ref of previous?.parents ?? []) {
    byParent.get(ref)?.delete(id);
  }
  rows.set(id, row);
  byKey.set(row.key, row);
  refs.set(records.logicalSessionRowIdentity(row.agentId, row.key), row);
  for (const ref of row.parents) {
    const children = byParent.get(ref) ?? new Set();
    children.add(id);
    byParent.set(ref, children);
  }
}
for (let index = 0; index < sessions; index++) {
  const agentId = `synthetic-${Math.floor(index / 100)}`;
  const parent = index % 100 === 0;
  const key = `agent:${agentId}:${parent ? "parent" : `subagent:${index}`}`;
  const entry = {
    sessionId: `session-${index}`,
    updatedAt: anchor - index,
    status: "done" as const,
    ...(parent ? {} : { parentSessionKey: `agent:${agentId}:parent`, archivedAt: anchor - 1 }),
  };
  put({
    ...records.create(
      { key, agentId, storeTarget: { agentId, storePath: `/synthetic/${agentId}.sqlite` } },
      entry,
    ),
    entry,
  });
}
for (const row of rows.values()) {
  assert(row.entry);
  row.parents = records.readSessionRowParents(row, row.entry, cfg, owner.current, referenced);
  put(row);
}
const relationships = createSessionRowRelationReads({
  env: process.env,
  inOwnerContext: AsyncLocalStorage.snapshot(),
  isReady: () => true,
  assertCurrent() {},
  preparedContext: () => owner.current,
  lookup: (query) => byKey.get(query.key),
  config: () => cfg,
  rows,
  byParent,
  dirty,
  referenced,
  readEntry: (row) => row.storedEntry,
  acquireEntry: (row) => row,
});
for (const row of rows.values()) {
  const { inputs } = readSessionRowInputs({
    cfg,
    key: row.key,
    agentId: row.agentId,
    entry: row.entry,
    store: {},
    storePath: row.storeTarget.storePath,
    rowContext: owner.current,
    childLinks: relationships.readChildLinks(row),
    active: false,
    activeModel: null,
    terminalModel: null,
    preparedAcpMeta: null,
    preparedRuntimeOwnership: null,
    preparedModelMetadata: null,
    preparedRepositoryWorkspace: null,
    lightweightListRow: true,
    skipTranscriptUsageFallback: true,
    includeSwarmChildren: true,
    now: anchor,
  });
  row.materialized = materializeSessionRow(inputs);
}
const selected = [...rows.values()].filter(
  (row): row is MaterializedRow => records.ready(row) && row.key.endsWith(":parent"),
);
assert.equal(selected.length, agents);
let refreshes = 0;
const readLinks = (row: Row) => {
  refreshes++;
  return relationships.readChildLinks(row);
};
const matching = ({ key }: { key: string }) => {
  const row = byKey.get(key);
  return row ? [row] : [];
};
let sequence = 0;
let consumedRows = 0;
const consume = (row: MaterializedRow) => {
  owner.preparePresentation(row, readLinks);
  const presented = records.present(row, owner.current, { now: anchor });
  if (presented.sessionId !== row.entry.sessionId) {
    throw new Error("Presented a different session");
  }
  consumedRows++;
};
function operation() {
  const number = sequence++;
  const index = (number % agents) * 100 + 1;
  const id = `run-${index}`;
  const previous = runs.get(id)!;
  const row: SubagentRunReadRecord = {
    ...previous,
    collectorCompletion: { status: Math.floor(number / agents) % 2 === 0 ? "failed" : "done" },
  };
  runs.set(id, row);
  publishSubagentRunChanges([row.childSessionKey], [id]);
  owner.prepare(sequence, cfg, matching, put, referenced);
  if (values.flow === "event") {
    const child = byKey.get(row.childSessionKey);
    assert(records.ready(child));
    consume(child);
    consume(selected[number % agents]!);
  } else {
    for (const selectedRow of selected) {
      consume(selectedRow);
    }
  }
}
const digest = () => {
  const result = createHash("sha256");
  for (const row of selected) {
    result.update(JSON.stringify(records.present(row, owner.current, { now: anchor })));
  }
  return result.digest("hex");
};
const inspector = new Session();
const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
try {
  for (let i = 0; i < 200; i++) {
    operation();
  }
  const verification = createHash("sha256");
  const verificationStates: string[] = [];
  const verify = () => {
    const hash = digest();
    verificationStates.push(hash);
    verification.update(hash);
  };
  for (let i = 0; i < 12; i++) {
    operation();
    verify();
  }
  const original = runs.get("run-1")!;
  const publish = (run: SubagentRunReadRecord | undefined) => {
    if (run) {
      runs.set(original.runId, run);
    } else {
      runs.delete(original.runId);
    }
    publishSubagentRunChanges([original.childSessionKey], [original.runId]);
    owner.prepare(++sequence, cfg, matching, put, referenced);
    for (const row of selected) {
      owner.preparePresentation(row, readLinks);
    }
    verify();
  };
  publish({
    ...original,
    controllerSessionKey: "agent:synthetic-2:parent",
    requesterSessionKey: "agent:synthetic-1:parent",
    requesterAgentId: "synthetic-1",
    swarmRequesterSessionKey: "agent:synthetic-1:parent",
  });
  publish(undefined);
  publish(original);
  snapshot = {};
  publishSubagentRunChanges();
  owner.prepare(++sequence, cfg, matching, put, referenced);
  for (const row of selected) {
    owner.preparePresentation(row, readLinks);
  }
  verify();
  refreshes = 0;
  consumedRows = 0;
  global.gc?.();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const samples: number[] = [];
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    const before = performance.now();
    operation();
    samples.push(performance.now() - before);
  }
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuStart);
  const allocated = values.allocation
    ? bytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      arm: values["base-context"] ? "base" : "candidate",
      mode: values.allocation ? "allocation" : "timing",
      sourceHashes: [...sources.values()].map((source) =>
        createHash("sha256").update(source).digest("hex"),
      ),
      node: process.version,
      sessions,
      agents,
      flow: values.flow,
      selectedRows: values.flow === "event" ? 2 : selected.length,
      consumedRows,
      iterations,
      refreshes,
      refreshesPerCall: refreshes / iterations,
      wallMs,
      cpuUsPerCall: (cpu.user + cpu.system) / iterations,
      sampledBytesPerCall: allocated === undefined ? undefined : allocated / iterations,
      synchronousP99Ms: samples[Math.floor(samples.length * 0.99)],
      longestSynchronousMs: samples.at(-1),
      verificationDigest: verification.digest("hex"),
      verificationStates,
      finalDigest: digest(),
      hostLoad: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  owner.dispose();
  inspector.disconnect();
  Date.now = actualNow;
}
