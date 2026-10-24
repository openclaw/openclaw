// Site allocation proof, not a Gateway/GC benchmark. Run with node --expose-gc.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [baselineRoot, candidateRoot] = process.argv.slice(2);
assert(
  baselineRoot && candidateRoot,
  "usage: node --expose-gc scripts/perf/private-array-copies-measure.mjs BASELINE_ROOT CANDIDATE_ROOT",
);
assert(globalThis.gc, "--expose-gc is required for cleanup outside measured windows");
const samples = 6;
const interval = 1024;
const generatedRoot = mkdtempSync(path.join(tmpdir(), "private-array-copies-"));
process.once("exit", () => rmSync(generatedRoot, { recursive: true, force: true }));
const paths = {
  task: "src/gateway/control-ui-session-task-prs.ts",
  topology: "src/agents/subagents/registry/subagent-registry-read-topology.ts",
  generation: "src/agents/subagents/registry/subagent-run-generation.ts",
  numbers: "packages/normalization-core/src/number-coercion.ts",
  scopes: "src/gateway/control-ui-session-pr-read.ts",
};
function between(source, start, end) {
  assert.equal(source.split(start).length, 2, `expected one ${start}`);
  const tail = source.slice(source.indexOf(start));
  assert.equal(tail.split(end).length, 2, `expected one ${end}`);
  return tail.slice(0, tail.indexOf(end));
}
async function load(root) {
  const sources = Object.fromEntries(
    Object.entries(paths).map(([key, file]) => [key, readFileSync(path.join(root, file), "utf8")]),
  );
  const hashes = Object.fromEntries(
    Object.entries(sources).map(([key, text]) => [
      key,
      createHash("sha256").update(text).digest("hex"),
    ]),
  );
  const sort = sources.task.match(/return sessions\.(?:toSorted|sort)\([\s\S]*?\n {2}\);/g);
  assert.equal(sort?.length, 1, "expected one task result sort");
  const scopes = sources.scopes.match(
    /(?:\[\.\.\.\(client\.connect\.scopes \?\? \[\]\)\]|\(client\.connect\.scopes \?\? \[\]\))\.toSorted\(\)\.join\("\\0"\)/g,
  );
  assert.equal(scopes?.length, 2, "expected two scope canonicalizations");
  assert.equal(scopes[0], scopes[1], "scope sites must use identical expressions");
  // Load the complete topology owner with its exact generation-selection dependencies.
  const generation = between(
    sources.generation,
    "function normalizeGeneration(",
    "export function isSubagentRunGenerationCandidate(",
  );
  const numbers = between(
    sources.numbers,
    "export function asFiniteNumber(",
    "export function asPositiveFiniteNumber(",
  );
  const topology = sources.topology.replace(/^import .*;\n/gm, "");
  assert(!/^import /m.test(topology), "topology dependencies changed; review harness extraction");
  const code = stripTypeScriptTypes(`${numbers}\n${generation}\n${topology}\n
export function taskSort(input) {
  const sessions = [];
  for (const row of input) sessions.push(row);
  ${sort[0]}
}
export function canonicalScopes(client) { return ${scopes[0]}; }
`);
  // Heap sampling truncates data URLs; short file URLs retain exact owner attribution.
  const generatedFile = path.join(
    generatedRoot,
    `${createHash("sha256").update(code).digest("hex")}.mjs`,
  );
  writeFileSync(generatedFile, code);
  const url = pathToFileURL(generatedFile).href;
  return { ...(await import(url)), url, hashes };
}
const owners = { baseline: await load(baselineRoot), candidate: await load(candidateRoot) };
const workloads = [];
for (const size of [1, 100, 5000]) {
  const rows = Array.from({ length: size }, (_, index) => ({
    sessionKey: `session-${String(size - index).padStart(5, "0")}`,
    agentId: "main",
  }));
  const expected = rows.toReversed();
  workloads.push({
    name: `task-sort-${size}`,
    size,
    calls: size === 5000 ? 1000 : 20000,
    setup(owner) {
      assert.deepEqual(owner.taskSort(rows), expected);
      assert.equal(rows[0].sessionKey, `session-${String(size).padStart(5, "0")}`);
      return () => owner.taskSort(rows).length;
    },
  });
}
for (const size of [100, 5000]) {
  for (const memoryKind of ["absent", "same", "distinct"]) {
    workloads.push({
      name: `topology-patch-${size}-${memoryKind}`,
      size,
      calls: size === 5000 ? 300 : 3000,
      setup(owner) {
        const rows = Array.from({ length: size }, (_, index) => ({
          runId: `run-${index}`,
          childSessionKey: "child",
          requesterSessionKey: "parent",
          generation: index,
          createdAt: index,
          execution: { status: "terminal" },
        }));
        const memory =
          memoryKind === "same"
            ? rows.at(-1)
            : memoryKind === "distinct"
              ? { ...rows.at(-1), runId: "memory", generation: size }
              : undefined;
        const topology = owner.buildSubagentRunReadTopology({
          runs: new Map(rows.map((row) => [row.runId, row])),
          inMemoryRuns: memory ? [memory] : [],
        });
        const changes = new Map([[rows[0].runId, rows[0]]]);
        const noMemoryChanges = new Map();
        const expected = memoryKind === "distinct" ? [...rows, memory] : rows;
        assert.deepEqual(topology.runsByChildSessionKey.get("child"), expected);
        return () => {
          topology.patch(changes, noMemoryChanges);
          return topology.runsByChildSessionKey.get("child").length;
        };
      },
    });
  }
}
const initialScopes = [
  "operator.write",
  "operator.read",
  "operator.sessions.write",
  "operator.admin",
];
for (const [name, scopes] of Object.entries({
  unchanged: initialScopes,
  reordered: initialScopes.toReversed(),
  added: [...initialScopes, "operator.approvals"],
  removed: initialScopes.slice(1),
  duplicate: [...initialScopes, "operator.read"],
  absent: undefined,
})) {
  workloads.push({
    name: `scopes-${name}`,
    size: scopes?.length ?? 0,
    calls: 100000,
    setup(owner) {
      const client = { connect: { scopes } };
      const expected = (scopes ?? []).toSorted().join("\0");
      assert.equal(owner.canonicalScopes(client), expected);
      return () => owner.canonicalScopes(client).length;
    },
  });
}
const inspector = new Session();
inspector.connect();
const results = [];
let checksum = 0;
try {
  console.log(
    JSON.stringify({
      protocol: "private-array-copies-v1",
      node: process.version,
      samplesPerSide: samples,
      samplingInterval: interval,
      includeCollected: true,
      scope:
        "C5 final private-array build/sort; C6 complete topology patch; C8 one canonicalization (both source sites identical)",
      hashes: { baseline: owners.baseline.hashes, candidate: owners.candidate.hashes },
    }),
  );
  for (const workload of workloads) {
    const operations = Object.fromEntries(
      Object.entries(owners).map(([side, owner]) => [side, workload.setup(owner)]),
    );
    for (const run of Object.values(operations)) {
      for (let warmup = 0; warmup < 200; warmup++) {
        checksum += run();
      }
    }
    for (let sample = 0; sample < samples; sample++) {
      for (const side of sample % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        globalThis.gc();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: interval,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        const run = operations[side];
        for (let call = 0; call < workload.calls; call++) {
          checksum += run();
        }
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const ownedIds = new Set();
        function visit(node, owned = false) {
          const inOwner = owned || node.callFrame.url === owners[side].url;
          if (inOwner) {
            ownedIds.add(node.id);
          }
          return (
            (inOwner ? node.selfSize : 0) +
            node.children.reduce((sum, child) => sum + visit(child, inOwner), 0)
          );
        }
        const allocatedBytes = visit(profile.head);
        const allocationSamples = profile.samples.filter((allocation) =>
          ownedIds.has(allocation.nodeId),
        ).length;
        assert(allocatedBytes > 0, `no owner allocation attributed for ${workload.name}`);
        const result = {
          workload: workload.name,
          size: workload.size,
          side,
          sample,
          calls: workload.calls,
          allocatedBytes,
          allocationSamples,
          bytesPerCall: allocatedBytes / workload.calls,
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
  }
  for (const workload of workloads) {
    const means = Object.fromEntries(
      ["baseline", "candidate"].map((side) => {
        const rows = results.filter((row) => row.workload === workload.name && row.side === side);
        return [
          side,
          {
            meanBytesPerCall: rows.reduce((sum, row) => sum + row.bytesPerCall, 0) / rows.length,
            minBytesPerCall: Math.min(...rows.map((row) => row.bytesPerCall)),
            maxBytesPerCall: Math.max(...rows.map((row) => row.bytesPerCall)),
            allocationSamples: rows.reduce((sum, row) => sum + row.allocationSamples, 0),
            calls: rows.reduce((sum, row) => sum + row.calls, 0),
            samples: rows.length,
          },
        ];
      }),
    );
    const delta = means.candidate.meanBytesPerCall - means.baseline.meanBytesPerCall;
    console.log(
      JSON.stringify({
        summary: workload.name,
        ...means,
        absoluteDeltaBytesPerCall: delta,
        relativeDeltaPercent: (delta / means.baseline.meanBytesPerCall) * 100,
      }),
    );
  }
  assert(checksum > 0);
} finally {
  inspector.disconnect();
}
