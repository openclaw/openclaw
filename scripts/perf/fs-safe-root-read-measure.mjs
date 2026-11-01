/**
 * Root traversal/read census, CPU, allocation and injected filesystem latency.
 * node --expose-gc scripts/perf/fs-safe-root-read-measure.mjs --fixture <synthetic-dir>
 * --fixture-files 62000 populates 1.116 GB; later passes reuse it. Run five serial
 * A1/B/A2 passes with --package-root selecting each built fs-safe source.
 * --delay-ms 100 delays the first target lstat (sync or async) in each operation.
 * --allocations samples V8 allocations separately from ordinary timings.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    "fixture-files": { type: "string", default: "0" },
    "package-root": { type: "string", default: "node_modules/@openclaw/fs-safe" },
    label: { type: "string", default: "A1" },
    iterations: { type: "string", default: "100" },
    warmups: { type: "string", default: "20" },
    "delay-ms": { type: "string", default: "0" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.fixture && global.gc, "Supply --fixture and run with --expose-gc");
const integer = (name) => {
  const value = Number(values[name]);
  assert(Number.isSafeInteger(value) && value >= 0, `Invalid --${name}`);
  return value;
};
const fixtureFiles = integer("fixture-files");
const delayMs = integer("delay-ms");
const iterations = delayMs ? 5 : integer("iterations");
assert(iterations > 0);
const fixture = path.resolve(values.fixture);
const target = path.join(fixture, "workspace-0", "nested", "payload.txt");
await fsp.mkdir(path.dirname(target), { recursive: true });
const bytes = Buffer.alloc(18_000, 65);
for (let index = 0; index < fixtureFiles; index++) {
  const directory = path.join(fixture, `workspace-${Math.floor(index / 1000)}`);
  if (index % 1000 === 0) {
    await fsp.mkdir(directory, { recursive: true });
  }
  await fsp.writeFile(path.join(directory, `synthetic-${index}.txt`), bytes);
}
await fsp.writeFile(target, bytes);
const packageRoot = path.resolve(values["package-root"]);
const require = createRequire(import.meta.url);
const { root } = await import(pathToFileURL(path.join(packageRoot, "dist/root.js")));
const { fileStore } = await import(pathToFileURL(path.join(packageRoot, "dist/store.js")));
const { resolveRootPath } = await import(pathToFileURL(path.join(packageRoot, "dist/advanced.js")));
const scoped = await root(fixture);
const store = fileStore({ rootDir: fixture, mode: 0o600, dirMode: 0o700 });
let active;
let injected = false;
const restores = [];
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function instrument(owner, name, async) {
  const original = owner[name];
  restores.push(() => {
    owner[name] = original;
  });
  owner[name] = function (...args) {
    if (active) {
      const key = `${async ? "async:" : ""}${name}`;
      active.counts[key] = (active.counts[key] ?? 0) + 1;
      if (delayMs && !injected && name.startsWith("lstat") && String(args[0]) === target) {
        injected = true;
        const sample = active;
        const start = performance.now();
        sample.timers.push(
          new Promise((resolve) => {
            setTimeout(() => {
              sample.timerMs.push(performance.now() - start);
              resolve();
            }, 0);
          }),
        );
        if (async) {
          return delay(delayMs).then(() => Reflect.apply(original, this, args));
        }
        Atomics.wait(sleeper, 0, 0, delayMs);
      }
    }
    return Reflect.apply(original, this, args);
  };
}
for (const name of [
  "openSync",
  "readSync",
  "writeSync",
  "statSync",
  "lstatSync",
  "fstatSync",
  "mkdirSync",
]) {
  instrument(fs, name, false);
}
for (const name of ["open", "readFile", "stat", "lstat", "mkdir", "realpath"]) {
  instrument(fsp, name, true);
}
syncBuiltinESMExports();
const cases = [
  {
    name: "resolveRootPath",
    run: () =>
      resolveRootPath({
        rootPath: scoped.rootReal,
        rootCanonicalPath: scoped.rootReal,
        absolutePath: target,
        boundaryLabel: "fixture",
      }),
  },
  {
    name: "Root.read",
    run: async () => {
      const result = await scoped.read("workspace-0/nested/payload.txt");
      assert.deepEqual(result.buffer, bytes);
    },
  },
  {
    name: "fileStore.open",
    run: async () => {
      await using opened = await store.open("workspace-0/nested/payload.txt");
      assert.equal(opened.stat.size, bytes.length);
    },
  },
];
try {
  for (const scenario of cases) {
    for (let i = 0; i < integer("warmups"); i++) {
      await scenario.run();
    }
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
    const sample = { counts: {}, timers: /** @type {Promise<void>[]} */ ([]), timerMs: [] };
    const load = loadavg();
    const cpuStart = process.cpuUsage();
    const threadStart = process.threadCpuUsage();
    const start = performance.now();
    active = sample;
    for (let i = 0; i < iterations; i++) {
      injected = false;
      await scenario.run();
      if (delayMs) {
        await Promise.all(sample.timers);
      }
    }
    active = undefined;
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const thread = process.threadCpuUsage(threadStart);
    let allocatedBytes;
    if (values.allocations) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sum = (node) => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
      allocatedBytes = sum(profile.head);
      inspector.disconnect();
    }
    await Promise.all(sample.timers);
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        label: values.label,
        node: process.version,
        platform: process.platform,
        load,
        iterations,
        delayMs,
        fsSafe: require(path.join(packageRoot, "package.json")).version,
        fixtureFilesCreated: fixtureFiles,
        fixtureBytesCreated: fixtureFiles * bytes.length,
        elapsedMsPerOperation: elapsedMs / iterations,
        mainCpuUsPerOperation: (thread.user + thread.system) / iterations,
        totalCpuUsPerOperation: (cpu.user + cpu.system) / iterations,
        sampledAllocationBytesPerOperation:
          allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
        callsPerOperation: Object.fromEntries(
          Object.entries(sample.counts).map(([key, count]) => [key, count / iterations]),
        ),
        timerMs: sample.timerMs,
      }),
    );
  }
} finally {
  active = undefined;
  for (const restore of restores.toReversed()) {
    restore();
  }
  syncBuiltinESMExports();
}
