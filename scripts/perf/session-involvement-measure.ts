/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-involvement-measure.ts
 * [--owner-file /absolute/path/base-session-row-selection.ts] [--allocation]
 * [--iterations 1000] [--changed 100]
 * Run five alternating base/candidate pairs, separately for CPU and allocation.
 * Each operation replaces 100 of 10k mixed-involvement rows, then selects a page
 * for one of 50 viewers. --changed 0 measures the unchanged-roster control.
 * Saved owner source uses the candidate's unchanged imports, via a load hook.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SubagentSessionListReadView } from "../../src/agents/subagents/registry/subagent-registry-state.js";
import type { InternalSessionEntry as SessionEntry } from "../../src/config/sessions/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    allocation: { type: "boolean" },
    iterations: { type: "string", default: "1000" },
    changed: { type: "string", default: "100" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 1000,
});
const changed = parseStrictIntegerOption({
  raw: values.changed,
  label: "changed",
  min: 0,
  fallback: 100,
});
const ownerUrl = new URL("../../src/gateway/session-row-selection.ts", import.meta.url);
if (values["owner-file"]) {
  const saved = pathToFileURL(values["owner-file"]);
  registerHooks({
    load(url, context, nextLoad) {
      return nextLoad(url === ownerUrl.href ? saved.href : url, context);
    },
  });
}
const { createSessionRowSelection } = await import("../../src/gateway/session-row-selection.js");
const { selectSessionEntries } = await import("../../src/gateway/session-utils-list.js");
const { createSessionRowProjectionContext } =
  await import("../../src/gateway/session-row-projection-context.js");
const { readSessionListSelectionFacts } = await import("../../src/gateway/session-list-target.js");
const cfg = { agents: { entries: { main: {} } } };
const runs: ReturnType<SubagentSessionListReadView["runs"]> = new Map();
const contextOwner = createSessionRowProjectionContext({
  snapshotIdentity: () => runs,
  runs: () => runs,
  prepare: async () => {},
});
const context = contextOwner.current;
const identities = context.userProfileIdentityById;
for (let index = 0; index < 50; index++) {
  const id = `profile-${index}`;
  identities.set(id, {
    kind: "resolved",
    profileId: id,
    label: `Viewer ${index}`,
    avatarUrl: `/avatar/${id}`,
    hasUploadedAvatar: true,
  });
}
const configuredAgentIds = new Set(["main"]);
const storePath = "/synthetic/involvement.sqlite";
const selection = createSessionRowSelection(
  cfg,
  {
    path: storePath,
    paths: new Map([[storePath, 0]]),
    agentId: "main",
    configuredAgentIds,
    ownerAgentIds: configuredAgentIds,
  },
  false,
  () => context,
);
const rows = Array.from({ length: 10_000 }, (_, index) => {
  const key = `agent:main:session-${index}`;
  const entry: SessionEntry = {
    sessionId: key,
    updatedAt: index + 1,
    createdActor: { type: "human", source: "profile", id: `profile-${index % 50}` },
    participants: Array.from({ length: 3 }, (_participant, offset) => ({
      identity: { type: "profile" as const, id: `profile-${(index + offset) % 50}` },
    })),
    profileInvolvement: {
      key,
      profiles: { [`profile-${(index + 3) % 50}`]: { hidden: index % 2 === 0, updatedAt: 1 } },
    },
    ...(index % 5 === 0 ? { archivedAt: 1 } : {}),
  };
  return {
    key,
    entry,
    agentId: "main",
    storeTarget: { agentId: "main", storePath },
    selection: readSessionListSelectionFacts(key, entry),
    generation: Symbol(key),
    hasBoard: false,
  };
});
for (const row of rows) {
  selection.add(row);
}
let checksum = 0;
function run(count: number) {
  for (let iteration = 0; iteration < count; iteration++) {
    for (let offset = 0; offset < changed; offset++) {
      const row = rows[(iteration * changed + offset) % rows.length]!;
      row.entry = { ...row.entry };
      selection.add(row);
    }
    const selected = selection.read();
    const result = selectSessionEntries({
      cfg,
      entries: selected.entries,
      getTarget: selected.get,
      involvementKeys: selected.involvementKeys,
      getRowContext: () => context,
      userProfileIdentityById: identities,
      configuredAgentIds,
      now: 20_000,
      opts: { limit: 100 },
      involvingActorId: `profile-${iteration % 50}`,
    });
    assert.equal(result.entries.length, 100);
    checksum += result.totalCount;
  }
}
try {
  run(100);
  checksum = 0;
  globalThis.gc?.();
  const inspector = new Session();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const start = process.threadCpuUsage();
  const wall = performance.now();
  run(iterations);
  const wallMs = performance.now() - wall;
  const cpu = process.threadCpuUsage(start);
  let bytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    bytes = sum(profile.head);
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      mode: values.allocation ? "allocation" : "timing",
      iterations,
      rows: rows.length,
      changed,
      cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      wallMs,
      sampledBytesPerOperation: bytes === undefined ? undefined : bytes / iterations,
      checksum,
      hostLoad,
    }),
  );
} finally {
  contextOwner.dispose();
}
