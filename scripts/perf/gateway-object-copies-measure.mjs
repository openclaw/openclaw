// Owner microbenchmark; this does not measure whole-Gateway latency or production frequency.
// Usage: node --expose-gc scripts/perf/gateway-object-copies-measure.mjs BASE_ROOT CAND_ROOT [CALLS=5000]
// Five alternating AB/BA passes, untraced CPU and separate sampled allocation passes.
// Reads exact source from both roots, including the unchanged canonical-entry helpers.
// Covers patch-entry canonicalization and empty worker-title reads; PR failure returns
// and async title fallbacks are covered by focused regressions, not this workload.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [baseRoot, candidateRoot, callsArgument = "5000"] = process.argv.slice(2);
assert(baseRoot && candidateRoot, "provide BASE_ROOT and CAND_ROOT");
assert(globalThis.gc, "use --expose-gc");
const calls = Number(callsArgument);
assert(Number.isSafeInteger(calls) && calls > 0, "CALLS must be a positive integer");
const pairs = 5;
const samplingInterval = 1024;
const generated = mkdtempSync(path.join(tmpdir(), "gateway-object-copies-"));
process.once("exit", () => rmSync(generated, { recursive: true, force: true }));
const files = {
  patch: "src/gateway/sessions-patch.ts",
  title: "src/gateway/session-transcript-title-reader.worker.ts",
  canonical: "src/config/sessions/store-entry-shape.ts",
  supported: "src/config/sessions/supported-session-store.ts",
  legacy: "src/config/sessions/session-entry-state-format.ts",
  delivery: "src/utils/delivery-context.shared.ts",
  number: "packages/normalization-core/src/number-coercion.ts",
  record: "packages/normalization-core/src/record-coerce.ts",
  string: "packages/normalization-core/src/string-coerce.ts",
  presentation: "packages/gateway-protocol/src/session-agent-status.ts",
  svg: "packages/gateway-protocol/src/svg-image.ts",
};
const hash = (source) => createHash("sha256").update(source).digest("hex");
function between(source, start, end) {
  assert.equal(source.split(start).length, 2, `expected one ${start}`);
  const tail = source.slice(source.indexOf(start));
  if (!end) {
    return tail;
  }
  assert.equal(tail.split(end).length, 2, `expected one ${end}`);
  return tail.slice(0, tail.indexOf(end));
}
const withoutImports = (source) => source.replace(/^import[\s\S]*?;\n/gm, "");
async function load(root, side) {
  const source = Object.fromEntries(
    Object.entries(files).map(([key, file]) => [key, readFileSync(path.join(root, file), "utf8")]),
  );
  const helpers = [
    "string",
    "number",
    "record",
    "svg",
    "presentation",
    "supported",
    "legacy",
    "canonical",
  ]
    .map((key) => withoutImports(source[key]))
    .join("\n");
  const delivery = between(
    source.delivery,
    "export function isCanonicalSessionDeliveryState(",
    "/** Builds one canonical delivery state",
  );
  const patch = between(source.patch, "  const existing =", "  // A read acknowledgement");
  const emptyTitle = between(
    source.title,
    "const EMPTY_SESSION_TITLE_FIELDS:",
    "// Session-list title probes",
  );
  const title = between(source.title, "export function readSessionTitleFieldsFromTranscript(");
  // Storage selection and its empty watermark are fixtures. Valid rows never
  // reach the migration-error constructor; focused patch tests cover rejection.
  // The canonicalizer's checks and normalizers remain exact source.
  const code = stripTypeScriptTypes(
    `class SessionStoreMigrationRequiredError extends Error {}
${helpers}\n${delivery}\n
export function canonicalizePatch(params) {
${patch}
  return existing;
}
${emptyTitle}
const captureSessionActorTranscriptRead = () => undefined;
const resolveSessionStorePathForScope = () => "/synthetic/sessions";
const resolveSessionTranscriptReadTargetCore = (input) => input;
const toTranscriptReadScope = (target) => target;
const watermark = Object.freeze({ maxSeq: null });
const readSessionTranscriptWatermark = () => watermark;
${title}
`,
    { mode: "strip" },
  );
  const file = path.join(generated, `${side}.mjs`);
  writeFileSync(file, code);
  const url = pathToFileURL(file).href;
  return {
    ...(await import(url)),
    url,
    hashes: Object.fromEntries(Object.entries(source).map(([key, value]) => [key, hash(value)])),
  };
}
const owners = {
  base: await load(baseRoot, "base"),
  candidate: await load(candidateRoot, "candidate"),
};
const rows = Array.from({ length: 10000 }, (_, index) =>
  Object.freeze({
    sessionId: `session-${index}`,
    updatedAt: 1000 + index,
    lifecycleRevision: `revision-${index}`,
    label: `Task ${index}`,
    autoLabel: `Task ${index}`,
    category: "synthetic",
    displayName: `Task ${index}`,
    agentRuntime: "mock",
    modelProvider: "mock",
    model: "model",
    inputTokens: 1000,
    outputTokens: 300,
    totalTokens: 1300,
    contextTokens: 32000,
    thinkingLevel: "low",
    fastMode: false,
    spawnedBy: "agent:main:main",
    spawnDepth: 1,
    archivedAt: 2000 + index,
    archiveReason: "age-retention",
    lastReadAt: 1000,
    systemSent: true,
    delivery: Object.freeze({ kind: "none" }),
  }),
);
const scopes = rows.map((row) =>
  Object.freeze({
    agentId: "main",
    sessionId: row.sessionId,
    sessionKey: `agent:main:subagent:${row.sessionId}`,
    storePath: "/synthetic/sessions",
  }),
);
const parameters = rows.map((existingEntry) => ({ existingEntry }));
const workloads = [
  {
    name: "patch-entry-canonicalization",
    run: (owner, index) => owner.canonicalizePatch(parameters[index % rows.length]),
    check: (result) => result.totalTokens,
  },
  {
    name: "empty-worker-title",
    run: (owner, index) =>
      owner.readSessionTitleFieldsFromTranscript(scopes[index % scopes.length]),
    check: (result) => Number(result.firstUserMessage === null),
  },
];
const results = [];
let checksum = 0;
let gcEntries = [];
const observer = new PerformanceObserver((list) => gcEntries.push(...list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
function allocationBytes(profile, url) {
  const ids = new Set();
  function visit(node, parentOwned = false) {
    const owned = parentOwned || node.callFrame.url === url;
    if (owned) {
      ids.add(node.id);
    }
    return (
      (owned ? node.selfSize : 0) +
      node.children.reduce((sum, child) => sum + visit(child, owned), 0)
    );
  }
  return {
    bytes: visit(profile.head),
    samples: profile.samples.filter((sample) => ids.has(sample.nodeId)).length,
  };
}
console.log(
  JSON.stringify({
    protocol: "gateway-object-copies-v1",
    node: process.version,
    pairs,
    calls,
    fixtureSessions: rows.length,
    samplingInterval,
    includeCollected: true,
    hashes: { base: owners.base.hashes, candidate: owners.candidate.hashes },
  }),
);
try {
  for (const workload of workloads) {
    for (let index = 0; index < rows.length; index++) {
      const before = structuredClone(rows[index]);
      assert.deepEqual(workload.run(owners.base, index), workload.run(owners.candidate, index));
      assert.deepEqual(rows[index], before);
    }
    for (const owner of Object.values(owners)) {
      for (let index = 0; index < 200; index++) {
        checksum += workload.check(workload.run(owner, index));
      }
    }
    for (const mode of ["cpu", "allocation"]) {
      const inspector = mode === "allocation" ? new Session() : undefined;
      inspector?.connect();
      try {
        for (let pair = 0; pair < pairs; pair++) {
          for (const side of pair % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"]) {
            globalThis.gc();
            await setImmediate();
            await setImmediate();
            gcEntries = [];
            if (inspector) {
              await inspector.post("HeapProfiler.startSampling", {
                samplingInterval,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            }
            const hostLoad = loadavg();
            const cpu = process.threadCpuUsage();
            const start = performance.now();
            for (let index = 0; index < calls; index++) {
              checksum += workload.check(workload.run(owners[side], index + pair * calls));
            }
            const end = performance.now();
            const used = process.threadCpuUsage(cpu);
            const memory = process.memoryUsage();
            const allocation = inspector
              ? allocationBytes(
                  (await inspector.post("HeapProfiler.stopSampling")).profile,
                  owners[side].url,
                )
              : undefined;
            await setImmediate();
            await setImmediate();
            const pauses = gcEntries.filter(
              (entry) => entry.startTime >= start && entry.startTime < end,
            );
            const gcByKind = new Map();
            for (const pause of pauses) {
              const kind = pause.detail.kind;
              const stats = gcByKind.get(kind) ?? { kind, count: 0, totalMs: 0, maxMs: 0 };
              stats.count++;
              stats.totalMs += pause.duration;
              stats.maxMs = Math.max(stats.maxMs, pause.duration);
              gcByKind.set(kind, stats);
            }
            const row = {
              workload: workload.name,
              mode,
              side,
              pair,
              calls,
              hostLoad,
              cpuUsPerCall: (used.user + used.system) / calls,
              wallMs: end - start,
              gcMs: pauses.reduce((sum, pause) => sum + pause.duration, 0),
              gcMaxMs: Math.max(0, ...pauses.map((pause) => pause.duration)),
              gcCount: pauses.length,
              gcByKind: [...gcByKind.values()],
              rssBytes: memory.rss,
              heapUsedBytes: memory.heapUsed,
              ...(allocation
                ? { bytesPerCall: allocation.bytes / calls, allocationSamples: allocation.samples }
                : {}),
            };
            results.push(row);
            console.log(JSON.stringify(row));
          }
        }
      } finally {
        inspector?.disconnect();
      }
    }
    for (const [mode, metric] of [
      ["cpu", "cpuUsPerCall"],
      ["allocation", "bytesPerCall"],
    ]) {
      const values = (side) =>
        results
          .filter((row) => row.workload === workload.name && row.mode === mode && row.side === side)
          .map((row) => row[metric]);
      const summarize = (side) => {
        const sample = values(side).toSorted((a, b) => a - b);
        return {
          mean: sample.reduce((sum, value) => sum + value, 0) / sample.length,
          median: sample[Math.floor(sample.length / 2)],
          min: sample[0],
          max: sample.at(-1),
        };
      };
      const base = summarize("base"),
        candidate = summarize("candidate");
      console.log(
        JSON.stringify({
          summary: workload.name,
          mode,
          metric,
          pairs,
          calls,
          base,
          candidate,
          absoluteDelta: candidate.mean - base.mean,
          deltaPercent: (candidate.mean / base.mean - 1) * 100,
        }),
      );
    }
  }
  assert(checksum > 0);
} finally {
  observer.disconnect();
}
