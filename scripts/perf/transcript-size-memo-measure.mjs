// Owner-only sizing/accounting proof; no Gateway, database, or LRU timing claim.
// node --expose-gc scripts/perf/transcript-size-memo-measure.mjs OWNER.ts cpu entries
// Repeat with allocation; omit entries for copy-on-write transcript appends.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { getHeapSnapshot } from "node:v8";
import { runInThisContext } from "node:vm";

const [ownerFile, mode = "table", workload = "transcripts"] = process.argv.slice(2);
assert(
  ownerFile &&
    ["table", "cpu", "allocation"].includes(mode) &&
    ["transcripts", "entries"].includes(workload) &&
    (workload === "transcripts" || mode !== "table"),
  "usage: node --expose-gc scripts/perf/transcript-size-memo-measure.mjs OWNER.ts [table|cpu|allocation] [transcripts|entries]",
);
assert(globalThis.gc, "--expose-gc is required");
const source = readFileSync(ownerFile, "utf8");
function between(start, end) {
  assert.equal(source.split(start).length, 2);
  const tail = source.slice(source.indexOf(start));
  assert.equal(tail.split(end).length, 2);
  return tail.slice(0, tail.indexOf(end));
}
let entries = 0;
class CountedWeakMap extends WeakMap {
  set(key, value) {
    if (!this.has(key)) {
      entries++;
    }
    return super.set(key, value);
  }
}
// Keep fixtures and callbacks in the production realm; scope the extracted owner privately.
const owner = runInThisContext(
  stripTypeScriptTypes(`
(function (WeakMap) {
${between("const transcriptSizes =", "const pool =")}
const pool = { snapshots: 0, bytes: 0 };
function touch() {}
${between("function retainTranscript(", "/** The caller already borrowed")}
return { retainTranscript, transcriptSizes, estimateReplicaBytes };
})
`),
)(mode === "table" ? CountedWeakMap : WeakMap);
function row(rawSeq) {
  return {
    rawSeq,
    serializedBytes: 512,
    event: {
      type: "message",
      id: `event-${rawSeq}`,
      parentId: rawSeq ? `event-${rawSeq - 1}` : null,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "synthetic response ".repeat(8) },
          {
            type: "toolCall",
            id: `call-${rawSeq}`,
            name: "synthetic",
            arguments: {
              files: Array.from({ length: 6 }, (_, i) => ({
                path: `file-${i}`,
                edits: [{ old: "before", new: "after" }],
              })),
              options: { flags: [true, false], range: { start: 0, end: 3 } },
            },
          },
        ],
        usage: { input: 100, output: 20 },
      },
    },
  };
}
function transcript(rows, sessionId = "synthetic") {
  return {
    sessionId,
    version: { generation: "synthetic", rawSeq: rows.length - 1, updatedAt: 1 },
    tail: { events: rows.slice(-128), coveredAfterSeq: -1 },
    context: {
      limits: { maxBytes: 1024 * 1024, maxEvents: 512 },
      rows,
      activeLeafEntryId: `event-${rows.length - 1}`,
    },
  };
}
const cell = { bytes: 0, transcriptBytes: 0 };
const report = {
  mode,
  workload,
  node: process.version,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
};
if (mode === "table") {
  // Hold rows as a second cache would, including after the replica itself is evicted.
  const fixtures = Array.from({ length: 16 }, (_session, i) =>
    transcript(
      Array.from({ length: 64 }, (_, j) => row(j)),
      `session-${i}`,
    ),
  );
  let estimatedBytes = 0;
  for (const fixture of fixtures) {
    owner.retainTranscript(cell, fixture);
    assert.equal(cell.transcriptBytes, owner.estimateReplicaBytes(fixture));
    estimatedBytes += cell.transcriptBytes;
  }
  globalThis.replicaSizeMemo = owner.transcriptSizes;
  globalThis.replicaSizeFixtures = fixtures;
  globalThis.gc();
  const chunks = [];
  for await (const chunk of getHeapSnapshot()) {
    chunks.push(chunk);
  }
  const heap = JSON.parse(Buffer.concat(chunks).toString());
  const nf = heap.snapshot.meta.node_fields;
  const ef = heap.snapshot.meta.edge_fields;
  const nw = nf.length,
    ew = ef.length;
  const nameIndex = ef.indexOf("name_or_index"),
    toIndex = ef.indexOf("to_node");
  const marker = heap.strings.indexOf("replicaSizeMemo");
  let mapNode;
  for (let e = 0; e < heap.edges.length; e += ew) {
    if (heap.edges[e + nameIndex] === marker) {
      mapNode = heap.edges[e + toIndex];
      break;
    }
  }
  assert.notEqual(mapNode, undefined);
  let edgeStart = 0;
  for (let n = 0; n < mapNode; n += nw) {
    edgeStart += heap.nodes[n + nf.indexOf("edge_count")] * ew;
  }
  let tableBytes;
  const end = edgeStart + heap.nodes[mapNode + nf.indexOf("edge_count")] * ew;
  for (let e = edgeStart; e < end; e += ew) {
    if (heap.strings[heap.edges[e + nameIndex]] === "table") {
      tableBytes = heap.nodes[heap.edges[e + toIndex] + nf.indexOf("self_size")];
    }
  }
  assert(tableBytes > 0, "WeakMap backing table was not found");
  Object.assign(report, {
    transcripts: fixtures.length,
    rows: 1024,
    entries,
    tableBytes,
    estimatedBytes,
  });
} else {
  const entryFixtures = Array.from({ length: 128 }, (_entry, index) => ({
    sessionKey: `agent:synthetic:session-${index}`,
    entry: {
      sessionId: `session-${index}`,
      updatedAt: 1,
      label: `Synthetic completed subagent ${index}`,
      skillsSnapshot: {
        prompt: "Synthetic skill instructions. ".repeat(512),
        skills: Array.from({ length: 40 }, (_skill, skill) => ({
          name: `skill-${skill}`,
          description: "Synthetic skill",
          filePath: `/synthetic/skill-${skill}/SKILL.md`,
        })),
      },
      pluginExtensions: Object.fromEntries(
        Array.from({ length: 40 }, (_plugin, plugin) => [
          `plugin-${plugin}`,
          { enabled: true, tags: ["synthetic", "completed"], settings: { limit: 8 } },
        ]),
      ),
    },
    snapshots: "full",
    dependencySessionIds: [`session-${index}`],
    writeToken: "synthetic:1",
  }));
  // Entry publications are deeply frozen before production byte accounting.
  function freezeFixture(value) {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) {
        freezeFixture(child);
      }
      Object.freeze(value);
    }
  }
  entryFixtures.forEach(freezeFixture);
  const fixtures =
    workload === "entries"
      ? []
      : Array.from({ length: 100 }, () => {
          const rows = Array.from({ length: 256 }, (_, i) => row(i));
          return Array.from({ length: 129 }, (_, i) => transcript(rows.slice(0, 128 + i)));
        });
  // Warm the code on disjoint rows; fixture construction is outside measurement.
  for (let i = 0; i < 1000; i++) {
    if (workload === "entries") {
      owner.estimateReplicaBytes(entryFixtures[i % entryFixtures.length]);
    } else {
      owner.retainTranscript(cell, transcript([row(i)]));
    }
  }
  // Seed each memo before timing so every measured retain appends exactly one row.
  for (const sequence of fixtures) {
    owner.retainTranscript(cell, sequence.shift());
  }
  const inspector = new Session();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  globalThis.gc();
  const cpu = process.cpuUsage();
  const start = performance.now();
  let calls = 0;
  let estimatedBytes = 0;
  if (workload === "entries") {
    for (let i = 0; i < 5000; i++) {
      estimatedBytes += owner.estimateReplicaBytes(entryFixtures[i % entryFixtures.length]);
      calls++;
    }
  }
  for (const sequence of fixtures) {
    for (const fixture of sequence) {
      owner.retainTranscript(cell, fixture);
      calls++;
    }
  }
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  Object.assign(report, {
    calls,
    cpuMs: (used.user + used.system) / 1000,
    wallMs,
    finalBytes: cell.transcriptBytes,
    estimatedBytes,
  });
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const total = (node) =>
      node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
    report.sampledAllocatedBytes = total(profile.head);
    inspector.disconnect();
  }
}
console.log(JSON.stringify(report));
