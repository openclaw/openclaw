import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "runtime-owner": { type: "string" },
    capsule: { type: "boolean", default: false },
    operations: { type: "string", default: "200000" },
    allocations: { type: "boolean", default: false },
    "start-file": { type: "string" },
    side: { type: "string" },
  },
});
assert(values.owner, "--owner is required");
assert(global.gc, "Run with --expose-gc");
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0);
const ownerUrl = pathToFileURL(resolve(values.owner)).href;
const source = readFileSync(new URL(ownerUrl));
const sourceSha256 = createHash("sha256").update(source).digest("hex");
// The capsule measures only factory setup. Unused collaborators must never run.
// Without --capsule, use the repository's normal source loader and dependencies.
if (values.capsule) {
  const unused =
    'const unused = () => { throw new Error("Setup capsule invoked an unrelated collaborator"); }; export { unused as err, unused as ok, unused as decodeSessionTranscriptWorkerReadError, unused as captureSessionTranscriptStorageEnvironment };';
  const unusedUrl = `data:text/javascript,${encodeURIComponent(unused)}`;
  const imports = new Set([
    "@openclaw/normalization-core/result",
    "./session-history-worker-errors.js",
    "./transcript-target-binding.js",
  ]);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === ownerUrl) {
        if (imports.has(specifier)) {
          return { url: unusedUrl, shortCircuit: true };
        }
        if (specifier === "./session-transcript-worker.types.js") {
          return {
            url: new URL("./session-transcript-worker.types.ts", ownerUrl).href,
            shortCircuit: true,
          };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}
const { createSessionHistoryWorkerReaders: factory } = await import(ownerUrl);
let create = factory;
let runtimeSourceSha256;
if (values["runtime-owner"]) {
  const runtimeSource = readFileSync(resolve(values["runtime-owner"]), "utf8");
  runtimeSourceSha256 = createHash("sha256").update(runtimeSource).digest("hex");
  const match = runtimeSource.match(
    /const owner: SessionHistoryWorkerDatabase = ([\s\S]+?)\n {4}return \{ owner, release \};/,
  );
  assert(match, "Expected retained reader owner construction in runtime source");
  // The owner path is trusted executable input, just like the imported reader module.
  // oxlint-disable-next-line typescript/no-implied-eval
  const construct = new Function(
    "createSessionHistoryWorkerReaders",
    "runRequest",
    "assertCurrent",
    `return ${match[1]}`,
  );
  const assertCurrent = () => {};
  create = (runner) => construct(factory, runner, assertCurrent);
}
const seen = [];
const runner = async (prepare, _bytes, receive) => {
  seen.push(prepare().kind);
  return receive({ stats: 41 });
};
const first = create(runner);
const second = create(async (prepare, _bytes, receive) => {
  seen.push(prepare().kind);
  return receive({ stats: 42 });
});
assert.equal(await first.readStats({}), 41);
assert.equal(await second.readStats({}), 42);
assert.deepEqual(seen, ["transcript-stats", "transcript-stats"]);
const methods = Object.keys(first).filter(
  (key) => key !== "runRequest" && key !== "assertCurrent" && typeof first[key] === "function",
);
const sharedMethods = methods.filter((key) => first[key] === second[key]).length;
const ring = Array.from({ length: 64 }, () => null);
function setup(count) {
  for (let i = 0; i < count; i++) {
    ring[i % ring.length] = create(runner);
  }
  assert.equal(typeof ring[0].readStats, "function");
}
setup(20000);
ring.fill(null);
global.gc();
if (values["start-file"]) {
  assert(values.side === "baseline" || values.side === "candidate");
  const startFile = values["start-file"];
  writeFileSync(`${startFile}.${values.side}.ready`, "ready");
  while (!existsSync(startFile)) {
    await delay(20);
  }
  const deadline = Number(readFileSync(startFile, "utf8"));
  assert(Number.isSafeInteger(deadline) && deadline > Date.now(), "Missed synchronized start");
  await delay(deadline - Date.now());
}
let profile;
let session;
if (values.allocations) {
  session = new Session();
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpuStart = process.cpuUsage();
const startedAt = Date.now();
const started = performance.now();
setup(operations);
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
if (session) {
  ({ profile } = await session.post("HeapProfiler.stopSampling"));
  session.disconnect();
}
let sampledBytes = 0;
let sampledFactoryBytes = 0;
function sum(node, inFactory = false) {
  const owned = inFactory || node.callFrame.url === ownerUrl;
  sampledBytes += node.selfSize;
  if (owned) {
    sampledFactoryBytes += node.selfSize;
  }
  for (const child of node.children) {
    sum(child, owned);
  }
}
if (profile) {
  sum(profile.head);
}
ring.fill(null);
global.gc();
const retainedCount = 10000;
const held = Array.from({ length: retainedCount }, () => null);
const beforeHeap = process.memoryUsage().heapUsed;
for (let i = 0; i < held.length; i++) {
  held[i] = create(runner);
}
global.gc();
const retainedBytes = process.memoryUsage().heapUsed - beforeHeap;
assert.equal(typeof held[retainedCount - 1].readStats, "function");
console.log(
  JSON.stringify({
    workload:
      "reader factory setup and optional extracted runtime owner construction; synthetic runner; no database, admission, worker or Gateway",
    node: process.version,
    sourceSha256,
    runtimeSourceSha256,
    capsule: values.capsule,
    operations,
    allocationSampling: values.allocations,
    startedAt,
    methods: methods.length,
    sharedMethods,
    freshMethodsPerFactory: methods.length - sharedMethods,
    elapsedMs,
    elapsedNsPerSetup: (elapsedMs * 1e6) / operations,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuNsPerSetup: ((cpu.user + cpu.system) * 1000) / operations,
    ...(profile
      ? {
          sampledBytes,
          sampledFactoryBytes,
          sampledBytesPerSetup: sampledBytes / operations,
          sampledFactoryBytesPerSetup: sampledFactoryBytes / operations,
        }
      : {}),
    retainedCount,
    retainedBytes,
    retainedBytesPerFactory: retainedBytes / retainedCount,
  }),
);
