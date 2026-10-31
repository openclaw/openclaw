/**
 * Native fs-safe owner census; identical A/A passes, not a candidate speedup claim.
 * node --expose-gc scripts/perf/fs-safe-write-main-thread-measure.mjs
 * Add --inject writeSync --delay-ms 100 for content-write latency, or inject
 * createStagedFile / renameReplace for native creation / atomic publication.
 * --allocations performs a separate inspector sampling pass. --fixture-files
 * 62000 creates ~1.1 GB of synthetic workspace siblings outside the measured loop.
 * No database is created: these file owners do not traverse agent databases.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    samples: { type: "string", default: "5" },
    iterations: { type: "string", default: "20" },
    "fixture-files": { type: "string", default: "0" },
    "delay-ms": { type: "string", default: "0" },
    inject: { type: "string", default: "writeSync" },
    allocations: { type: "boolean", default: false },
  },
});
function integer(name, minimum) {
  const value = Number(values[name]);
  assert(Number.isSafeInteger(value) && value >= minimum, `Invalid --${name}`);
  return value;
}
const samples = integer("samples", 1);
const delayMs = integer("delay-ms", 0);
const iterations = delayMs ? 1 : integer("iterations", 1);
const fixtureFiles = integer("fixture-files", 0);
assert(global.gc, "Run with --expose-gc");
const nativeMethods = ["createStagedFile", "renameReplace", "renameNoReplace", "stagedFileMatches"];
const fsMethods = [
  "writeSync",
  "fsyncSync",
  "fchmodSync",
  "fstatSync",
  "lstatSync",
  "statSync",
  "write",
  "fsync",
];
assert([...nativeMethods, ...fsMethods].includes(values.inject), "Unknown injection point");
const originals = [];
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let active;
function instrument(owner, name) {
  const original = owner[name];
  assert.equal(typeof original, "function", `Missing ${name}`);
  originals.push(() => {
    owner[name] = original;
  });
  owner[name] = function (...args) {
    if (active) {
      active.counts[name] = (active.counts[name] ?? 0) + 1;
      if (delayMs && values.inject === name) {
        const sample = active;
        const start = performance.now();
        sample.timers.push(
          new Promise((resolve) => {
            setTimeout(() => {
              sample.lateness.push(performance.now() - start);
              resolve();
            }, 0);
          }),
        );
        if (name === "write" || name === "fsync") {
          setTimeout(() => Reflect.apply(original, this, args), delayMs);
          return undefined;
        }
        Atomics.wait(sleeper, 0, 0, delayMs);
      }
    }
    return Reflect.apply(original, this, args);
  };
}
for (const name of fsMethods) {
  instrument(fs, name);
}
syncBuiltinESMExports();
const require = createRequire(import.meta.url);
const dist = path.dirname(require.resolve("@openclaw/fs-safe"));
// Internal import only instruments the dependency in this isolated probe process.
const { getNativeBinding } = await import(pathToFileURL(path.join(dist, "native.js")));
const { configureFsSafeNative } = await import("@openclaw/fs-safe/config");
configureFsSafeNative({ mode: "require" });
const binding = getNativeBinding(...nativeMethods);
for (const name of nativeMethods) {
  instrument(binding, name);
}
const { root } = await import("@openclaw/fs-safe/root");
const { fileStore } = await import("@openclaw/fs-safe/store");
await fsp.mkdir(".local", { recursive: true });
const fixture = await fsp.mkdtemp(path.resolve(".local/fs-safe-write-measure-"));
try {
  const siblingBytes = Buffer.alloc(18_000, 65);
  for (let directory = 0; directory < Math.ceil(fixtureFiles / 1000); directory++) {
    const dir = path.join(fixture, `workspace-${directory}`);
    await fsp.mkdir(dir);
    for (
      let index = directory * 1000;
      index < Math.min(fixtureFiles, (directory + 1) * 1000);
      index++
    ) {
      await fsp.writeFile(path.join(dir, `synthetic-${index}.txt`), siblingBytes);
    }
  }
  const scoped = await root(fixture);
  const store = fileStore({ rootDir: fixture, mode: 0o600, dirMode: 0o700 });
  const small = Buffer.alloc(1024, 66);
  const large = Buffer.alloc(65537, 67);
  let created = 0;
  const cases = [
    { name: "root.write-1KiB", bytes: small, run: () => scoped.write("root-small", small) },
    {
      name: "root.create-1KiB",
      bytes: small,
      run: () => scoped.create(`created-${created++}`, small),
    },
    { name: "fileStore.write-1KiB", bytes: small, run: () => store.write("store-small", small) },
    { name: "root.write-65537B", bytes: large, run: () => scoped.write("root-large", large) },
  ];
  for (const scenario of cases) {
    await scenario.run();
  }
  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
    for (const scenario of sampleIndex % 2 ? cases.toReversed() : cases) {
      await nextTurn();
      global.gc();
      await nextTurn();
      const inspector = new Session();
      if (values.allocations) {
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const sample = { counts: {}, timers: /** @type {Promise<void>[]} */ ([]), lateness: [] };
      const loadBefore = loadavg();
      const cpuBefore = process.cpuUsage();
      const threadBefore = process.threadCpuUsage();
      const start = performance.now();
      active = sample;
      for (let index = 0; index < iterations; index++) {
        await scenario.run();
      }
      active = undefined;
      const elapsedMs = performance.now() - start;
      const threadCpu = process.threadCpuUsage(threadBefore);
      const cpu = process.cpuUsage(cpuBefore);
      let allocatedBytes;
      if (values.allocations) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const sum = (node) =>
          node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
        allocatedBytes = sum(profile.head);
        inspector.disconnect();
      }
      await Promise.all(sample.timers);
      console.log(
        JSON.stringify({
          scenario: scenario.name,
          sample: sampleIndex + 1,
          control: "A/A",
          node: process.version,
          fsSafe: require("@openclaw/fs-safe/package.json").version,
          platform: process.platform,
          filesystemFixtureBytes: fixtureFiles * siblingBytes.length,
          fixtureFiles,
          iterations,
          bytesPerWrite: scenario.bytes.length,
          delayMs,
          injection: values.inject,
          allocationSampling: values.allocations,
          loadBefore,
          elapsedMs,
          mainThreadCpuUsPerWrite: (threadCpu.user + threadCpu.system) / iterations,
          totalCpuUsPerWrite: (cpu.user + cpu.system) / iterations,
          allocatedBytesPerWrite:
            allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
          callsPerWrite: Object.fromEntries(
            Object.entries(sample.counts).map(([key, count]) => [key, count / iterations]),
          ),
          injectedTimerDelayMs: sample.lateness,
        }),
      );
    }
  }
  assert.deepEqual(await fsp.readFile(path.join(fixture, "root-small")), small);
  assert.deepEqual(await fsp.readFile(path.join(fixture, "root-large")), large);
  assert.deepEqual(await fsp.readFile(path.join(fixture, "store-small")), small);
} finally {
  active = undefined;
  for (const restore of originals.toReversed()) {
    restore();
  }
  syncBuiltinESMExports();
  await fsp.rm(fixture, { recursive: true, force: true });
}
