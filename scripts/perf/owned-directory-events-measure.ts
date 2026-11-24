// Source-owner measurement: real subscriptions, replayed native event callbacks.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/owned-directory-events-measure.ts
//   --state-dir <new-directory> [--owner <frozen-owner.ts>] [--allocations] [--event change|rename]
// The synthetic host adapter measures owner delivery, not subprocess transport or filesystem throughput.
import assert from "node:assert/strict";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeGatewayGcTraceMarker, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    owner: { type: "string" },
    operations: { type: "string", default: "4000" },
    "start-at": { type: "string", default: "0" },
    "gc-log": { type: "string" },
    output: { type: "string" },
    allocations: { type: "boolean", default: false },
    event: { type: "string", default: "change" },
    missing: { type: "boolean", default: false },
    "watch-dir": { type: "string" },
    "batch-delay-ms": { type: "string", default: "1" },
  },
});
assert.ok(values["state-dir"], "--state-dir must name a new synthetic directory");
assert.ok(global.gc, "Run with --expose-gc");
assert.ok(["linux", "darwin"].includes(process.platform), "Native callback replay requires Unix");
assert.ok(
  values.event === "change" || values.event === "rename",
  "--event must be change or rename",
);
const event = values.event;
const integer = (name: "operations" | "start-at", min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const operations = integer("operations", 1);
const batchDelayMs = parseStrictIntegerOption({
  raw: values["batch-delay-ms"],
  label: "--batch-delay-ms",
  min: 0,
  fallback: 1,
});
// Replay the owner boundary, independent of the subprocess transport used in production.
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/directory-watch-host.ts") || url.endsWith("/directory-watch-host.js")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
        import fs from "node:fs";
        import { EventEmitter } from "node:events";
        export function watchDirectory(directory, listener, recursive) {
          try {
            if (recursive) fs.accessSync(directory);
            return fs.watch(directory, { persistent: false, recursive }, listener);
          } catch (error) {
            const watch = Object.assign(new EventEmitter(), { close() {} });
            queueMicrotask(() => watch.emit("error", error, true));
            return watch;
          }
        }
      `,
      };
    }
    return nextLoad(url, context);
  },
});
const startAt = integer("start-at", 0);
const stateDir = path.resolve(values["state-dir"]);
fs.mkdirSync(stateDir);
const root = values["watch-dir"]
  ? path.resolve(values["watch-dir"])
  : path.join(stateDir, "agents", "main", "agent");
fs.mkdirSync(root, { recursive: true });
const profilePath = path.join(stateDir, "allocation.heapprofile");
writeGatewayGcTraceMarker("identify-start", profilePath);
global.gc();
writeGatewayGcTraceMarker("identify-stop", profilePath);
const { observeOwnedDirectory }: typeof import("../../src/infra/owned-directory-observation.js") =
  await import(
    values.owner
      ? pathToFileURL(path.resolve(values.owner)).href
      : "../../src/infra/owned-directory-observation.js"
  );

const native: {
  watch(
    this: void,
    filename: fs.PathLike,
    options: fs.WatchOptionsWithStringEncoding,
    listener: fs.WatchListener<string>,
  ): fs.FSWatcher;
} = fs;
const originalWatch = native.watch;
const callbacks: fs.WatchListener<string>[] = [];
native.watch = (filename, options, listener) => {
  // Replay alone drives delivery; incidental native events would corrupt the fixed work count.
  const watcher = originalWatch(filename, options, () => {});
  callbacks.push(listener);
  return watcher;
};
const subscriptions: Array<{ close(): void }> = [];
let directNotifications = 0;
let descendantNotifications = 0;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
try {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  subscriptions.push(
    observeOwnedDirectory(
      root,
      (filename) => {
        assert.ok(filename === "auth-profiles.json" || filename === "missing");
        directNotifications++;
      },
      { reconcileIntervalMs: 3_600_000 },
    ),
  );
  subscriptions.push(
    observeOwnedDirectory(
      path.join(root, "missing", "target"),
      (filename) => {
        assert.equal(filename, undefined);
        descendantNotifications++;
      },
      { reconcileIntervalMs: 3_600_000 },
    ),
  );
  await nextTurn();
} finally {
  hooks.deregister();
  Object.defineProperty(process, "platform", platform);
  native.watch = originalWatch;
}
assert.equal(callbacks.length, 1, "Both subscriptions share the real root watch");
const callback = callbacks[0]!;
const run = () => {
  for (let index = 0; index < 64; index++) {
    callback(event, "auth-profiles.json");
  }
  callback("change", "missing");
};
// Measure the common direct-root case separately from the missing-directory filter.
// Close the missing subscriber after proving that shared callbacks scoped it correctly.
run();
assert.equal(directNotifications, 65);
assert.equal(descendantNotifications, 1);
if (!values.missing) {
  subscriptions.pop()!.close();
}
for (let warmup = 0; warmup < 100; warmup++) {
  run();
}
directNotifications = 0;
descendantNotifications = 0;

function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const count = sorted.length;
  return {
    count,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    maxMs: sorted.at(-1) ?? 0,
    p95: { samples: count, ms: sorted[Math.ceil(count * 0.95) - 1] ?? null },
    p99: { samples: count, ms: sorted[Math.ceil(count * 0.99) - 1] ?? null },
  };
}
function allocation(profile: HeapProfiler.SamplingHeapProfile) {
  let totalBytes = 0;
  let ownerBytes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, owner = false) => {
    const inOwner = owner || node.callFrame.url.includes("owned-directory-observation");
    totalBytes += node.selfSize;
    if (inOwner) {
      ownerBytes += node.selfSize;
    }
    node.children.forEach((child) => visit(child, inOwner));
  };
  visit(profile.head);
  return {
    totalBytes,
    ownerBytes,
    bytesPerEvent: totalBytes / (operations * 65),
    ownerBytesPerEvent: ownerBytes / (operations * 65),
  };
}
const inspector = new Session();
const loop = monitorEventLoopDelay({ resolution: 1 });
const collections: Array<{ kind: number; ms: number }> = [];
let measuredStart = Infinity;
let measuredEnd = Infinity;
function recordGc(records: PerformanceEntry[]) {
  for (const entry of records) {
    if (entry.startTime >= measuredStart && entry.startTime < measuredEnd) {
      collections.push({
        kind: (entry as typeof entry & { detail: { kind: number } }).detail.kind,
        ms: entry.duration,
      });
    }
  }
}
const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
try {
  global.gc();
  await nextTurn();
  inspector.connect();
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  loop.enable();
  observer.observe({ entryTypes: ["gc"] });
  fs.writeSync(1, `DIRECTORY_READY ${JSON.stringify({ pid: process.pid, startAt })}\n`);
  if (startAt) {
    assert.ok(Date.now() < startAt, "Missed --start-at after warmup");
    await delay(startAt - Date.now());
  }
  const latency: number[] = [];
  const hostLoad = os.loadavg();
  const cpu = process.cpuUsage();
  loop.reset();
  writeGatewayGcTraceMarker("heap-start", profilePath);
  measuredStart = performance.now();
  for (let operation = 0; operation < operations; operation++) {
    const started = performance.now();
    run();
    latency.push(performance.now() - started);
    if (batchDelayMs) {
      await delay(batchDelayMs);
    } else {
      await nextTurn();
    }
  }
  measuredEnd = performance.now();
  const usedCpu = process.cpuUsage(cpu);
  writeGatewayGcTraceMarker("heap-stop", profilePath);
  loop.disable();
  await nextTurn();
  recordGc(observer.takeRecords());
  observer.disconnect();
  let sampledAllocation;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    fs.writeFileSync(profilePath, JSON.stringify(profile));
    sampledAllocation = allocation(profile);
  }
  assert.equal(directNotifications, operations * 65);
  assert.equal(descendantNotifications, values.missing ? operations : 0);
  const gc = (kind?: number) =>
    distribution(
      collections
        .filter((entry) => kind === undefined || entry.kind === kind)
        .map((entry) => entry.ms),
    );
  const result = {
    scope:
      "real owned-directory subscriptions; fixed native callback replay, not filesystem or Gateway throughput",
    node: process.version,
    operations,
    event,
    missing: values.missing,
    hostLoad,
    batchDelayMs,
    events: directNotifications,
    allocation: sampledAllocation,
    batchLatency: distribution(latency),
    elapsedMs: measuredEnd - measuredStart,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    gc: {
      total: gc(),
      minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
      major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    },
    promotion: values["gc-log"]
      ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath)
      : null,
    eventLoop: {
      samples: loop.count,
      maxMs: loop.max / 1e6,
      p95: { samples: loop.count, ms: loop.percentile(95) / 1e6 },
      p99: { samples: loop.count, ms: loop.percentile(99) / 1e6 },
    },
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    fs.writeFileSync(values.output, output);
  }
  fs.writeSync(1, output);
} finally {
  for (const subscription of subscriptions) {
    subscription.close();
  }
  loop.disable();
  observer.disconnect();
  inspector.disconnect();
}
