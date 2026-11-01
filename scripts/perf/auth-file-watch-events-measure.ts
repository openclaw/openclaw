// Real auth-file owner + directory observer, replaying unrelated native rename callbacks.
// Native fs.watch handles are mocked; the production callback composition stays intact.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/auth-file-watch-events-measure.ts
//   --state-dir <new-directory> [--owner <frozen-file-state.ts>] [--allocations] [--output <json>]
// Run CPU/GC untraced; allocation sampling is a separate pass. This does not measure
// filesystem throughput or native onchange allocations. macOS uses the Linux adapter
// during setup only. --max-owner-bytes-per-event optionally gates a sampled pass.
// --identities defaults to one database per agent; use four for multi-database sensitivity.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    owner: { type: "string" },
    operations: { type: "string", default: "4000" },
    identities: { type: "string", default: "1" },
    allocations: { type: "boolean", default: false },
    output: { type: "string" },
    "max-owner-bytes-per-event": { type: "string" },
  },
});
assert.ok(values["state-dir"], "--state-dir must name a new synthetic directory");
assert.ok(global.gc, "Run with --expose-gc");
assert.ok(["linux", "darwin"].includes(process.platform), "Callback replay requires Unix");
const operations = parseStrictIntegerOption({
  raw: values.operations,
  label: "--operations",
  min: 1,
  fallback: 4000,
});
const identities = parseStrictIntegerOption({
  raw: values.identities,
  label: "--identities",
  min: 1,
  fallback: 1,
});
const limit =
  values["max-owner-bytes-per-event"] === undefined
    ? undefined
    : Number(values["max-owner-bytes-per-event"]);
assert.ok(limit === undefined || (values.allocations && Number.isFinite(limit) && limit >= 0));
const stateDir = path.resolve(values["state-dir"]);
fs.mkdirSync(stateDir);
process.env.OPENCLAW_STATE_DIR = stateDir;
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner)).href
  : new URL("../../src/agents/auth-profiles/file-state.ts", import.meta.url).href;
const {
  captureAuthProfileFileIdentity,
  authProfileFileChanges,
}: typeof import("../../src/agents/auth-profiles/file-state.js") = await import(ownerUrl);
const { closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db-cache.js");
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
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
class SilentWatch extends EventEmitter implements fs.FSWatcher {
  close() {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
native.watch = (_filename, _options, listener) => {
  callbacks.push(listener);
  return new SilentWatch();
};
try {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  for (let agent = 0; agent < 64; agent++) {
    const directory = path.join(stateDir, "agents", `agent-${agent}`, "agent");
    fs.mkdirSync(directory, { recursive: true });
    for (let identity = 0; identity < identities; identity++) {
      const databasePath = path.join(directory, `database-${identity}.sqlite`);
      fs.writeFileSync(databasePath, "synthetic identity fixture");
      captureAuthProfileFileIdentity(databasePath).assertCurrent();
    }
  }
} finally {
  Object.defineProperty(process, "platform", platform);
  native.watch = originalWatch;
}
assert.equal(callbacks.length, 64, "Each agent directory shares one watch registration");
let publications = 0;
authProfileFileChanges.onChange = () => {
  publications++;
};
const run = () => {
  for (const callback of callbacks) {
    callback("rename", "database-0.sqlite-journal");
  }
};
for (let warmup = 0; warmup < 100; warmup++) {
  run();
}
const events = operations * callbacks.length;
const inspector = new Session();
const loop = monitorEventLoopDelay({ resolution: 1 });
const collections: Array<{ kind: number; ms: number }> = [];
let start = Infinity;
let end = Infinity;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime >= start && entry.startTime < end) {
      collections.push({
        kind: (entry as typeof entry & { detail: { kind: number } }).detail.kind,
        ms: entry.duration,
      });
    }
  }
});
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
  observer.observe({ entryTypes: ["gc"] });
  loop.enable();
  const hostLoadStart = os.loadavg();
  const cpu = process.cpuUsage();
  start = performance.now();
  for (let operation = 0; operation < operations; operation++) {
    run();
    await nextTurn();
  }
  end = performance.now();
  const usedCpu = process.cpuUsage(cpu);
  const hostLoadEnd = os.loadavg();
  loop.disable();
  await nextTurn();
  await nextTurn();
  let allocation:
    | { totalBytes: number; ownerBytes: number; bytesPerEvent: number; ownerBytesPerEvent: number }
    | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    let totalBytes = 0;
    let ownerBytes = 0;
    const visit = (node: HeapProfiler.SamplingHeapProfileNode, owned = false) => {
      const inOwner =
        owned ||
        node.callFrame.url === ownerUrl ||
        node.callFrame.url.includes("owned-directory-observation");
      totalBytes += node.selfSize;
      if (inOwner) {
        ownerBytes += node.selfSize;
      }
      for (const child of node.children) {
        visit(child, inOwner);
      }
    };
    visit(profile.head);
    allocation = {
      totalBytes,
      ownerBytes,
      bytesPerEvent: totalBytes / events,
      ownerBytesPerEvent: ownerBytes / events,
    };
    fs.writeFileSync(path.join(stateDir, "allocation.heapprofile"), JSON.stringify(profile));
  }
  const gc = (kind?: number) => {
    const selected = collections.filter((entry) => kind === undefined || entry.kind === kind);
    return {
      count: selected.length,
      totalMs: selected.reduce((sum, entry) => sum + entry.ms, 0),
      maxMs: selected.reduce((max, entry) => Math.max(max, entry.ms), 0),
    };
  };
  assert.equal(publications, 0, "Sidecar rename events must not publish auth observations");
  const output = `${JSON.stringify(
    {
      scope:
        "real auth-file owner and directory observer; mocked native handles, callback replay only",
      node: process.version,
      operations,
      directories: callbacks.length,
      identitiesPerDirectory: identities,
      events,
      publications,
      elapsedMs: end - start,
      replayEventsPerMinute: (events * 60_000) / (end - start),
      cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      allocation,
      gc: {
        total: gc(),
        minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
        major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
      },
      eventLoop: { samples: loop.count, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 },
      hostLoadStart,
      hostLoadEnd,
      memory: process.memoryUsage(),
    },
    null,
    2,
  )}\n`;
  if (values.output) {
    fs.writeFileSync(values.output, output);
  }
  fs.writeSync(1, output);
  if (limit !== undefined) {
    assert.ok(
      allocation!.ownerBytesPerEvent <= limit,
      `Owner allocation ${allocation!.ownerBytesPerEvent.toFixed(2)} B/event exceeds ${limit}`,
    );
  }
} finally {
  loop.disable();
  observer.disconnect();
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
}
