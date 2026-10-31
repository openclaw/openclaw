/**
 * Session-row index owner benchmark; no Gateway/socket/model-turn claim.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-row-index-measure.ts
 * Save the baseline identities module and repeat with --base-file <saved.ts>.
 * Alternate arms; run --allocation separately from untraced timing. Defaults:
 * 10,800 rows, 40 agents/stores, five update/read passes, unique and colliding aliases.
 * Compare source hashes, fixture digests and iterations. Acceptance: identical readers,
 * lower retained bytes/allocation, and no consistent CPU regression across matched arms.
 * Retention is a post-GC process delta after fixture creation, not additive V8 field sizes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { Row } from "../../src/gateway/session-row-projection-record.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "base-file": { type: "string" },
    allocation: { type: "boolean" },
    sessions: { type: "string", default: "10800" },
    passes: { type: "string", default: "5" },
  },
});
const sessions = parseStrictIntegerOption({
  raw: values.sessions,
  label: "--sessions",
  min: 40,
  fallback: 10800,
});
const passes = parseStrictIntegerOption({
  raw: values.passes,
  label: "--passes",
  min: 1,
  fallback: 5,
});
assert(global.gc, "Run with --expose-gc");
const ownerUrl = new URL("../../src/gateway/session-row-projection-identities.ts", import.meta.url);
const source = readFileSync(values["base-file"] ?? ownerUrl, "utf8");
registerHooks({
  load(url, context, nextLoad) {
    return url === ownerUrl.href
      ? { format: "module-typescript", source, shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { indexSessionRow } = await import("../../src/gateway/session-row-projection-identities.js");
const records = await import("../../src/gateway/session-row-projection-record.js");
const { selectMatchingSessionRows } = await import("../../src/gateway/session-row-scope.js");
type Indexes = Parameters<typeof indexSessionRow>[1];
const emptyIndexes = (): Indexes => ({
  byStore: new Map(),
  byAgent: new Map(),
  byKey: new Map(),
  byParent: new Map(),
});
const inspector = new Session();
const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
async function measure(iterations: number, work: () => void) {
  if (values.allocation) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const loadStart = loadavg();
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  work();
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuStart);
  const allocatedBytes = values.allocation
    ? bytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  return {
    iterations,
    wallMs,
    cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
    sampledBytesPerOperation:
      allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    loadStart,
    loadEnd: loadavg(),
  };
}
function digest(indexes: Indexes) {
  const hash = createHash("sha256");
  for (const [name, map] of Object.entries(indexes)) {
    hash.update(name);
    for (const [key, ids] of Array.from(map).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      hash.update(JSON.stringify([key, [...ids]]));
    }
  }
  return hash.digest("hex");
}
function census(indexes: Indexes) {
  const unique = new Set<Set<string>>();
  const structures = Object.fromEntries(
    Object.entries(indexes).map(([name, map]) => {
      const buckets = [...map.values()];
      for (const bucket of buckets) {
        unique.add(bucket);
      }
      return [
        name,
        {
          buckets: map.size,
          uniqueSets: new Set(buckets).size,
          singletonBuckets: buckets.filter((bucket) => bucket.size === 1).length,
          references: buckets.reduce((sum, bucket) => sum + bucket.size, 0),
        },
      ];
    }),
  );
  return { structures, uniqueSetsAcrossIndexes: unique.size };
}

try {
  if (values.allocation) {
    inspector.connect();
  }
  for (const collisions of [false, true]) {
    const inventory: Row[] = [];
    const rows = new Map<string, Row>();
    for (let index = 0; index < sessions; index++) {
      const agentId = `agent-${index % 40}`;
      const prefix = (collisions ? index % 64 : index).toString(16).padStart(8, "0");
      const uuid = `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      const key = `agent:${agentId}:${index % 5 === 0 ? "dashboard" : "subagent"}:${uuid}`;
      const entry = {
        sessionId: collisions ? `shared-${Math.floor(index / 40)}` : uuid,
        updatedAt: 1_750_000_000_000 + index,
        label: `Synthetic completed task ${collisions ? index % 128 : index}`,
        status: "done" as const,
        ...(index % 5 === 0 ? { archivedAt: 1 } : {}),
      };
      const row = records.create(
        {
          key,
          agentId,
          storeTarget: { agentId, storePath: `/synthetic/${agentId}/sessions.sqlite` },
        },
        entry,
      );
      row.entry = entry;
      row.parents.add(`logical:${agentId}\0agent:${agentId}:main`);
      inventory.push(row);
      rows.set(records.identity(row), row);
    }
    const indexes = emptyIndexes();
    // Warm the exact update path; only the empty maps and fixed fixture survive the checkpoint.
    for (let pass = 0; pass < 2; pass++) {
      for (const row of inventory) {
        indexSessionRow(row, indexes);
      }
      for (const row of inventory) {
        indexSessionRow(row, indexes, true);
      }
    }
    assert(Object.values(indexes).every((map) => map.size === 0));
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    for (const row of inventory) {
      indexSessionRow(row, indexes);
    }
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const counts = census(indexes);
    const beforeDigest = digest(indexes);
    const select = (index: number, kind: number) => {
      const row = inventory[index]!;
      const query =
        kind === 0
          ? { key: row.key }
          : kind === 1
            ? { key: row.entry!.sessionId }
            : kind === 2
              ? { storePath: row.storeTarget.storePath }
              : { agentId: row.agentId };
      return selectMatchingSessionRows(
        { rows, indexes, scope: undefined },
        query,
        kind === 1 ? "id" : "key",
      );
    };
    // Expected identities come directly from fixture facts, independently of all indexes.
    for (let index = 0; index < 40; index++) {
      const target = inventory[index]!;
      for (let kind = 0; kind < 4; kind++) {
        const expected = inventory.filter((row) =>
          kind === 0
            ? row.key === target.key
            : kind === 1
              ? row.entry!.sessionId === target.entry!.sessionId
              : kind === 2
                ? row.storeTarget.storePath === target.storeTarget.storePath
                : row.agentId === target.agentId,
        );
        assert.deepEqual(select(index, kind).map(records.identity), expected.map(records.identity));
      }
    }
    const update = await measure(sessions * passes, () => {
      for (let pass = 0; pass < passes; pass++) {
        for (const row of inventory) {
          indexSessionRow(row, indexes, true);
          indexSessionRow(row, indexes);
        }
      }
    });
    assert.equal(digest(indexes), beforeDigest);
    const reads = [];
    for (let kind = 0; kind < 4; kind++) {
      let returned = 0;
      const result = await measure(sessions * passes, () => {
        for (let pass = 0; pass < passes; pass++) {
          for (let index = 0; index < sessions; index++) {
            returned += select(index, kind).length;
          }
        }
      });
      reads.push({ kind: ["key", "id", "store", "agent"][kind], returned, ...result });
    }
    console.log(
      JSON.stringify({
        arm: values["base-file"] ? "base" : "candidate",
        sourceHash: createHash("sha256").update(source).digest("hex"),
        node: process.version,
        mode: values.allocation ? "allocation" : "timing",
        sessions,
        stores: 40,
        collisions,
        passes,
        indexDigest: beforeDigest,
        retainedIndexBytes: heapAfter - heapBefore,
        heapBefore,
        heapAfter,
        counts,
        update,
        reads,
        memory: process.memoryUsage(),
      }),
    );
    for (const row of inventory) {
      indexSessionRow(row, indexes, true);
    }
    assert(Object.values(indexes).every((map) => map.size === 0));
  }
} finally {
  inspector.disconnect();
}
