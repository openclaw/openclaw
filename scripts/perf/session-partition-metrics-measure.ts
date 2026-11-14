// Compare identical frozen checkouts with and without partition counters; no Gateway or live state.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { SessionListFilteredEntries } from "../../src/gateway/session-list-filters.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "3600" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.output && global.gc, "--output and --expose-gc are required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations >= 30);
const output = path.resolve(values.output);
const state = `${output}.state`;
mkdirSync(state, { recursive: true });
const config = path.join(state, "openclaw.json");
writeFileSync(config, JSON.stringify({ plugins: { enabled: false } }));
process.env = createGatewayBenchEnv(state, config, { startupTrace: false });
const { create } = await import("../../src/gateway/session-row-projection-record.ts");
const { createSessionRowSelection } = await import("../../src/gateway/session-row-selection.ts");
const { selectSessionEntries } = await import("../../src/gateway/session-utils-list.ts");
const { buildSessionListRowMetadataContext } =
  await import("../../src/gateway/session-utils-projection.ts");
const { buildSubagentSessionListReadIndex } =
  await import("../../src/agents/subagents/registry/subagent-registry-read.ts");
const cfg = { agents: { entries: { main: {} } } };
const now = 1_800_000_000_000;
const context = buildSessionListRowMetadataContext({
  now,
  subagentRuns: buildSubagentSessionListReadIndex(now, undefined, new Map()),
});
const storePath = path.join(state, "synthetic.sqlite");
const agents = new Set(["main"]);
const selection = createSessionRowSelection(
  cfg,
  {
    path: storePath,
    paths: new Map([[storePath, 0]]),
    agentId: "main",
    configuredAgentIds: agents,
    ownerAgentIds: agents,
  },
  false,
  () => context,
);
const rows = Array.from({ length: 10_800 }, (_, index) => {
  const kind = index < 4_300 ? "subagent" : index < 9_100 ? "dashboard" : "explicit";
  const key = `agent:main:${kind}:synthetic-${index}`;
  const entry = {
    sessionId: `synthetic-${index}`,
    updatedAt: now - index,
    visibility: "shared" as const,
    ...(index >= 4_300 && index < 8_700 ? { archivedAt: now - 1 } : {}),
  };
  const row = {
    ...create({ key, agentId: "main", storeTarget: { agentId: "main", storePath } }, entry),
    entry,
  };
  selection.add(row);
  return row;
});
const views = Array.from({ length: 30 }, () => new WeakMap<object, SessionListFilteredEntries>());
let checksum = 0;
const pass = (index: number) => {
  if (index % views.length === 0) {
    const row = rows[Math.floor(index / views.length) % 4_300]!;
    selection.add({ ...row, entry: { ...row.entry, updatedAt: now + index } });
  }
  const prepared = selection.read();
  const result = selectSessionEntries({
    ...prepared,
    cfg,
    opts: { limit: 100 },
    now,
    getTarget: prepared.get,
    getRowContext: () => context,
    retained: views[index % views.length],
  });
  checksum += result.totalCount + result.entries.length;
};
for (let index = 0; index < 300; index++) {
  pass(index);
}
global.gc();
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 128,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpu = process.threadCpuUsage();
for (let index = 300; index < iterations + 300; index++) {
  pass(index);
}
const used = process.threadCpuUsage(cpu);
let allocationBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const bytes = (node: typeof profile.head): number =>
    node.selfSize + node.children.reduce((total, child) => total + bytes(child), 0);
  allocationBytes = bytes(profile.head);
  inspector.disconnect();
}
writeFileSync(
  output,
  JSON.stringify(
    {
      iterations,
      views: views.length,
      sessions: rows.length,
      cpuMicrosPerSelection: (used.user + used.system) / iterations,
      sampledAllocationBytesPerSelection:
        allocationBytes === undefined ? undefined : allocationBytes / iterations,
      checksum,
    },
    null,
    2,
  ),
);
