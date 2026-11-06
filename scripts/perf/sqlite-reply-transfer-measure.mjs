// Receiver-owner proof; run paired processes on the approved benchmark host.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";

const { values, positionals: roots } = parseArgs({
  allowPositionals: true,
  options: {
    shape: { type: "string", default: "all" },
    operations: { type: "string" },
    "start-at": { type: "string" },
    allocations: { type: "boolean", default: false },
  },
});
assert(
  roots.length,
  "usage: node sqlite-reply-transfer-measure.mjs ROOT [ROOT...] [--shape BYTES]; options: --operations N --start-at EPOCH_MS --allocations",
);
const positiveInteger = (value) => {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number > 0, `invalid positive integer: ${value}`);
  return number;
};
const shapes =
  values.shape === "all" ? [1024, 16384, 131072, 9437184] : [positiveInteger(values.shape)];
const operations = values.operations === undefined ? undefined : positiveInteger(values.operations);
const startAt = values["start-at"] === undefined ? undefined : positiveInteger(values["start-at"]);
assert(
  startAt === undefined || (roots.length === 1 && shapes.length === 1),
  "--start-at requires one root and one shape",
);
const generated = mkdtempSync(path.join(tmpdir(), "sqlite-reply-transfer-"));
process.once("exit", () => rmSync(generated, { recursive: true, force: true }));

const files = {
  owner: "src/infra/sqlite-worker-transfer.ts",
  record: "packages/normalization-core/src/record-coerce.ts",
  errors: "src/infra/sqlite-lifecycle-errors.ts",
};
const dependencies = {
  owner: {
    "@openclaw/normalization-core/record-coerce": "record",
    "./sqlite-lifecycle-errors.js": "errors",
  },
};
async function loadOwner(root, index) {
  const hashes = {};
  for (const [key, file] of Object.entries(files)) {
    let source = readFileSync(path.resolve(root, file), "utf8");
    hashes[file] = createHash("sha256").update(source).digest("hex");
    if (key === "errors") {
      const start = "export function createSqliteLifecycleAggregateError(";
      const end =
        "/** Settle a synchronous SQLite operation and preserve both operation and cleanup failures. */";
      assert.equal(source.split(start).length, 2, "lifecycle error start anchor changed");
      assert.equal(source.split(end).length, 2, "lifecycle error end anchor changed");
      assert(source.indexOf(end) > source.indexOf(start), "lifecycle error anchors reordered");
      source = source.slice(source.indexOf(start), source.indexOf(end));
      assert.equal(
        source.split("export function throwSqliteLifecycleErrors(").length,
        2,
        "lifecycle cleanup helper changed",
      );
    }
    for (const [specifier, dependency] of Object.entries(dependencies[key] ?? {})) {
      const quoted = JSON.stringify(specifier);
      assert.equal(source.split(quoted).length, 2, `dependency changed: ${file}: ${specifier}`);
      source = source.replace(quoted, JSON.stringify(`./${index}-${dependency}.mjs`));
    }
    // Keep the complete receiver and record helpers; extract only its two real cleanup functions.
    const code = stripTypeScriptTypes(source, { mode: "strip" });
    assert(!code.includes('from "@'), `unresolved package dependency in ${file}`);
    writeFileSync(path.join(generated, `${index}-${key}.mjs`), code);
  }
  const url = pathToFileURL(path.join(generated, `${index}-owner.mjs`)).href;
  return { module: await import(url), hashes, url };
}

function prepare(owner, size) {
  const payload = {
    kind: "session-entry-patch",
    applied: true,
    entry: {
      sessionId: "synthetic-session",
      updatedAt: 1700000000000,
      label: "synthetic reply",
      skillsSnapshot: { prompt: "x".repeat(size), skills: [{ name: "synthetic", enabled: true }] },
    },
    publication: { changedKeys: ["agent:synthetic:main"], generationUnchangedKeys: [] },
  };
  const producer = owner.createSqliteWorkerTransferOwner();
  const handle = producer.start([{ kind: "patch", value: payload }].values(), { kinds: ["patch"] });
  const frames = [];
  for (;;) {
    const frame = producer.next(handle.id);
    frames.push(frame);
    if (frame.done) {
      break;
    }
  }
  producer.end(handle.id);
  let last;
  let consumed = 0;
  const consume = ({ kind, value }) => {
    assert.equal(kind, "patch");
    assert.equal(value.entry.skillsSnapshot.prompt.length, size);
    last = value;
    consumed++;
  };
  const run = () => {
    const receiver = owner.createSqliteWorkerTransferReceiver(handle, consume);
    let counts;
    for (const frame of frames) {
      counts = receiver.accept(frame);
    }
    assert.equal(counts?.[0]?.[1], 1);
  };
  run();
  assert.deepEqual(last, payload);
  return {
    run,
    verify(expectedCount) {
      assert.equal(consumed, expectedCount);
      assert.deepEqual(last, payload);
    },
    payloadBytes: serialize(payload).byteLength,
    frames: frames.length - 1,
  };
}

function distribution(durations) {
  const sorted = durations.toSorted((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    count: sorted.length,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    maxMs: sorted.at(-1) ?? null,
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}
const gcKinds = {
  minor: constants.NODE_PERFORMANCE_GC_MINOR,
  major: constants.NODE_PERFORMANCE_GC_MAJOR,
  incremental: constants.NODE_PERFORMANCE_GC_INCREMENTAL,
  weak: constants.NODE_PERFORMANCE_GC_WEAKCB,
};

async function measure(workload, ownsFrame) {
  const count = operations ?? Math.max(200, Math.ceil(1024 ** 3 / workload.payloadBytes));
  const warmup = Math.max(2, Math.min(200, Math.ceil((32 * 1024 ** 2) / workload.payloadBytes)));
  const batchSize = Math.max(1, Math.min(64, Math.floor((512 * 1024) / workload.payloadBytes)));
  for (let index = 0; index < warmup; index++) {
    workload.run();
  }
  await setImmediate();
  const inspector = values.allocations ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (startAt !== undefined) {
    assert(Date.now() < startAt, "warmup missed the synchronized start; discard the pair");
    await setTimeout(startAt - Date.now());
  }
  const gc = [];
  const observer = new PerformanceObserver((list) => gc.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const wallStarted = Date.now();
  const started = performance.now();
  const cpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  for (let index = 0; index < count; index++) {
    workload.run();
    if ((index + 1) % batchSize === 0) {
      await setImmediate();
    }
  }
  const threadUsed = process.threadCpuUsage(threadCpu);
  const cpuUsed = process.cpuUsage(cpu);
  const ended = performance.now();
  loop.disable();
  // Drain asynchronous GC entries, retaining only collections starting in the fixed-work window.
  await setImmediate();
  await setImmediate();
  gc.push(...observer.takeRecords());
  observer.disconnect();
  const measuredGc = gc.filter((entry) => entry.startTime >= started && entry.startTime < ended);
  let allocation;
  if (inspector) {
    try {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const ids = new Set();
      const visit = (node, owned = false) => {
        const included = owned || ownsFrame(node.callFrame);
        if (included) {
          ids.add(node.id);
        }
        return (
          (included ? node.selfSize : 0) +
          node.children.reduce((sum, child) => sum + visit(child, included), 0)
        );
      };
      const bytes = visit(profile.head);
      allocation = {
        sampledOwnerBytes: bytes,
        bytesPerOperation: bytes / count,
        samples: profile.samples.filter((sample) => ids.has(sample.nodeId)).length,
        samplingInterval: 1024,
        includesCollected: true,
        excludesExternalBackingStores: true,
      };
    } finally {
      inspector.disconnect();
    }
  }
  workload.verify(1 + warmup + count);
  const elapsedMs = ended - started;
  const allGc = distribution(measuredGc.map((entry) => entry.duration));
  return {
    payloadBytes: workload.payloadBytes,
    dataFrames: workload.frames,
    count,
    warmup,
    batchSize,
    wallStarted,
    elapsedMs,
    cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    threadCpuMs: (threadUsed.user + threadUsed.system) / 1000,
    gc: {
      ...allGc,
      msPerOperation: allGc.totalMs / count,
      msPerMinute: (allGc.totalMs * 60000) / elapsedMs,
      kinds: Object.fromEntries(
        Object.entries(gcKinds).map(([name, kind]) => [
          name,
          distribution(
            measuredGc.filter((entry) => entry.detail.kind === kind).map((entry) => entry.duration),
          ),
        ]),
      ),
    },
    loop: {
      count: loop.count,
      p95Ms: loop.count ? loop.percentile(95) / 1e6 : null,
      p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
      maxMs: loop.count ? loop.max / 1e6 : null,
      resolutionMs: 10,
    },
    allocation,
  };
}

function report(metadata, result) {
  console.log(
    JSON.stringify({
      protocol: "sqlite-reply-transfer-v2",
      mode: values.allocations
        ? "allocation"
        : process.execArgv.includes("--trace-gc-nvp")
          ? "traced"
          : "untraced",
      node: process.version,
      loadavg: loadavg(),
      ...metadata,
      ...result,
    }),
  );
}

for (const [index, root] of roots.entries()) {
  const owner = await loadOwner(root, index);
  for (const size of shapes) {
    const result = await measure(prepare(owner.module, size), (frame) => frame.url === owner.url);
    report(
      {
        scope:
          "Prepared frames through the complete receiver; excludes producer, IPC, SQL, and Gateway work. Natural GC only. Allocation runs are separate diagnostic passes, not timing gates.",
        root: path.resolve(root),
        hashes: owner.hashes,
        size,
      },
      result,
    );
  }
}
