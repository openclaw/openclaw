// Diagnostic preload only: native frame copies and store presence, never store contents.
const asyncHooks = require("node:async_hooks");
const { writeFileSync, renameSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { relative } = require("node:path");

const output = process.env.OPENCLAW_ASYNC_CONTEXT_PROBE_OUT;
if (!output) {
  throw new Error("Set OPENCLAW_ASYNC_CONTEXT_PROBE_OUT to a task-owned JSON output path");
}
function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
const sampleEvery = positiveInteger("OPENCLAW_ASYNC_CONTEXT_PROBE_SAMPLE_EVERY", 8);
const intervalMs = positiveInteger("OPENCLAW_ASYNC_CONTEXT_PROBE_INTERVAL_MS", 30_000);
const NativeStorage = asyncHooks.AsyncLocalStorage;
const nativeEnterWith = Function.prototype.call.bind(NativeStorage.prototype.enterWith);
const root = new asyncHooks.AsyncResource("OpenClawAsyncContextProbeValidation");
const frameSymbol = Object.getOwnPropertySymbols(root).find((key) =>
  String(key).includes("context_frame"),
);
function currentFrame() {
  const resource = new asyncHooks.AsyncResource("OpenClawAsyncContextProbeSample");
  const frame = resource[frameSymbol];
  resource.emitDestroy();
  return frame;
}
function unsupported() {
  throw new Error(
    `Async-context probe requires Node AsyncContextFrame Map internals (${process.version})`,
  );
}
if (!frameSymbol || typeof nativeEnterWith !== "function") {
  unsupported();
}
// Check that even same-value enterWith makes a distinct frame containing the native store.
root.runInAsyncScope(() => {
  const storage = new NativeStorage();
  const marker = {};
  nativeEnterWith(storage, marker);
  const first = currentFrame();
  nativeEnterWith(storage, marker);
  const second = currentFrame();
  if (
    first === second ||
    [first, second].some(
      (frame) =>
        !frame ||
        typeof frame.size !== "number" ||
        typeof frame.get !== "function" ||
        typeof frame[Symbol.iterator] !== "function" ||
        frame.get(storage) !== marker ||
        ![...frame].some(([store, value]) => store === storage && value === marker),
    )
  ) {
    unsupported();
  }
});
root.emitDestroy();

const sites = new WeakMap();
function constructionSite() {
  for (const line of new Error().stack.split("\n").slice(1)) {
    if (line.includes(__filename) || line.includes("node:")) {
      continue;
    }
    const location = line.match(/(?:file:\/\/)?(\/[^()]+):\d+:\d+\)?$/)?.[1];
    if (location) {
      const position = line.match(/:(\d+:\d+)\)?$/)[1];
      return `${relative(process.cwd(), location)}:${position}`;
    }
  }
  return "untracked";
}
class TrackedAsyncLocalStorage extends NativeStorage {
  constructor(options) {
    super(options);
    sites.set(this, constructionSite());
  }
}
Object.defineProperty(asyncHooks, "AsyncLocalStorage", {
  value: TrackedAsyncLocalStorage,
  writable: true,
  configurable: true,
  enumerable: true,
});
syncBuiltinESMExports();

const owners = new Map();
const entering = new Map();
const histogram = new Map();
let copies = 0;
let samples = 0;
let entries = 0;
let activeEntries = 0;
let random = 0x42c0ffee;
const startedAt = Date.now();
function counters(map, owner) {
  let row = map.get(owner);
  if (!row) {
    row = { owner, copies: 0, samples: 0, entries: 0, active: 0, undefined: 0 };
    map.set(owner, row);
  }
  return row;
}
NativeStorage.prototype.enterWith = function (value) {
  copies += 1;
  const writer = counters(entering, sites.get(this) ?? "untracked");
  writer.copies += 1;
  // Randomized selection avoids always sampling the restoration half of native run().
  random ^= random << 13;
  random ^= random >>> 17;
  random ^= random << 5;
  if (random >>> 0 < 0x1_0000_0000 / sampleEvery) {
    const frame = currentFrame();
    const size = frame?.size ?? 0;
    samples += 1;
    entries += size;
    writer.samples += 1;
    writer.entries += size;
    histogram.set(size, (histogram.get(size) ?? 0) + 1);
    if (frame) {
      for (const [store, storedValue] of frame) {
        const row = counters(owners, sites.get(store) ?? "untracked");
        row.entries += 1;
        if (storedValue === undefined) {
          row.undefined += 1;
          writer.undefined += 1;
        } else {
          row.active += 1;
          writer.active += 1;
          activeEntries += 1;
        }
      }
    }
  }
  return nativeEnterWith(this, value);
};

function flush() {
  const mean = (sum, count) => (count ? sum / count : null);
  const report = {
    format: "openclaw-async-context-probe-v1",
    node: process.version,
    pid: process.pid,
    startedAt,
    capturedAt: Date.now(),
    sampleEvery,
    copies,
    samples,
    entries,
    activeEntries,
    undefinedEntries: entries - activeEntries,
    meanFrameEntries: mean(entries, samples),
    meanActiveEntries: mean(activeEntries, samples),
    frameSizeHistogram: [...histogram].toSorted((a, b) => a[0] - b[0]),
    owners: [...owners.values()]
      .toSorted((a, b) => b.entries - a.entries)
      .map(({ owner, entries: present, active, undefined: absent }) => ({
        owner,
        present,
        active,
        undefined: absent,
        entriesPerSample: mean(present, samples),
      })),
    enteringOwners: [...entering.values()]
      .toSorted((a, b) => b.entries - a.entries)
      .map((row) => ({
        owner: row.owner,
        copies: row.copies,
        samples: row.samples,
        entries: row.entries,
        active: row.active,
        undefined: row.undefined,
        meanFrameEntries: mean(row.entries, row.samples),
      })),
  };
  const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, output);
}
flush();
setInterval(flush, intervalMs).unref();
process.on("exit", flush);
