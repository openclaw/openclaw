/**
 * Synthetic cgroupfs owner replay: 26 leaves become idle after command completion,
 * 9.3 GB modeled cache, plus two live peers and 4,000 session identities.
 * No real sysfs, database, workspace or kernel reclaim is accessed.
 * Supply the original owner module as argv[2], materialized beside its original
 * imports (for example src/process/.agent-exec-cgroup-baseline.ts via git show).
 * Run: pnpm exec tsx scripts/perf/agent-exec-cgroup-teardown-measure.mts <baseline>
 * Remove the temporary baseline module after the replay.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import * as candidate from "../../src/process/linux-exec-cgroup.js";

type Owner = {
  reclaimAgentExecCgroup: typeof candidate.reclaimAgentExecCgroup;
  startAgentExecCgroupCleanup?: typeof candidate.startAgentExecCgroupCleanup;
};
assert(process.argv[2], "Supply the original owner module path");
const baseline: Owner = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const original = { writeFile: fs.promises.writeFile, rmdir: fs.promises.rmdir };
const directories = Array.from(
  { length: 4_000 },
  (_, index) => `/synthetic/agent-exec/session-${index.toString(16).padStart(32, "0")}`,
);
const pending = directories.slice(0, 28);
const states = new Map<string, { live: boolean; bytes: number }>();
const watchers = new Map<string, SyntheticWatcher>();
let reads = 0;
let writes = 0;
let removals = 0;
let peakWatches = 0;
let activeWrites = 0;
let peakWrites = 0;
let completed: (() => void) | undefined;
class SyntheticWatcher extends EventEmitter implements fs.FSWatcher {
  readonly directory: string;
  constructor(directory: string) {
    super();
    this.directory = directory;
  }
  close() {
    watchers.delete(this.directory);
    this.removeAllListeners();
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
const inspector = new Session();
inspector.connect();
Object.defineProperty(process, "platform", { value: "linux", configurable: true });
mock.method(
  fs,
  "watch",
  (file: string, _options: unknown, callback: (...args: unknown[]) => void) => {
    const directory = path.dirname(file);
    assert(states.has(directory), `unexpected watch ${file}`);
    const watcher = new SyntheticWatcher(directory);
    watcher.on("change", callback);
    watchers.set(directory, watcher);
    peakWatches = Math.max(peakWatches, watchers.size);
    return watcher;
  },
);
mock.method(fs.promises, "readFile", async (file: string) => {
  reads++;
  const state = states.get(path.dirname(file));
  assert(state, `unexpected read ${file}`);
  switch (path.basename(file)) {
    case "cgroup.events":
      return `populated ${state.live ? 1 : 0}\nfrozen 0\n`;
    case "cgroup.procs":
      return state.live ? "123\n" : "";
    case "memory.current":
      return String(state.bytes);
    default:
      throw new Error(`unexpected read ${file}`);
  }
});
fs.promises.writeFile = async (file, data) => {
  assert(typeof file === "string" && typeof data === "string");
  assert.equal(path.basename(file), "memory.reclaim");
  const state = states.get(path.dirname(file))!;
  assert(!state.live);
  assert.equal(data, String(state.bytes));
  writes++;
  peakWrites = Math.max(peakWrites, ++activeWrites);
  await Promise.resolve();
  state.bytes = 0;
  activeWrites--;
};
fs.promises.rmdir = async (directory) => {
  const state = states.get(String(directory))!;
  assert(!state.live && state.bytes === 0, "remove must follow reclaim");
  states.delete(String(directory));
  removals++;
};

try {
  const modes = [
    "warmup",
    ...Array.from({ length: 5 }, () => ["before", "after"]).flat(),
    ...Array.from({ length: 5 }, () => ["control-a", "control-a2"]).flat(),
  ];
  for (const [sample, mode] of modes.entries()) {
    const owner: Owner = mode === "before" ? baseline : candidate;
    states.clear();
    pending.forEach((directory, index) =>
      states.set(directory, {
        live: true,
        bytes: index === 0 ? 2_000_000_000 : index < 26 ? 7_300_000_000 / 25 : 1024 ** 3,
      }),
    );
    reads = writes = removals = peakWatches = activeWrites = peakWrites = 0;
    const controller = new AbortController();
    const batchDone = new Promise<void>((resolve) => {
      completed = resolve;
    });
    owner.startAgentExecCgroupCleanup?.(controller.signal, {
      info: (message) => {
        if (message.includes("source=watcher")) {
          completed?.();
        }
      },
    });
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const cpu = process.cpuUsage();
    const start = performance.now();
    await Promise.all(pending.map(owner.reclaimAgentExecCgroup));
    // All original completion attempts saw populated=1. Only later kernel events
    // announce that descendants left; no second completion call is manufactured.
    for (const directory of pending.slice(0, 26)) {
      states.get(directory)!.live = false;
      watchers.get(directory)?.emit("change", "change", "cgroup.events");
    }
    if (mode !== "before") {
      await batchDone;
    }
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const deadBytes = [...states.values()]
      .filter((state) => !state.live)
      .reduce((sum, state) => sum + state.bytes, 0);
    assert.equal(removals, mode === "before" ? 0 : 26);
    assert.equal(states.get(pending[26]!)!.bytes, 1024 ** 3);
    assert.equal(states.get(pending[27]!)!.bytes, 1024 ** 3);
    controller.abort();
    assert.equal(watchers.size, 0);
    console.log(
      JSON.stringify({
        sample,
        mode,
        elapsedMs,
        cpuMs: (used.user + used.system) / 1000,
        allocatedBytes: profile.samples.reduce((sum, entry) => sum + entry.size, 0),
        reads,
        writes,
        removals,
        peakWrites,
        peakWatches,
        deadBytes,
        load: loadavg(),
      }),
    );
  }
} finally {
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  mock.restoreAll();
  Object.assign(fs.promises, original);
  Object.defineProperty(process, "platform", originalPlatform);
  inspector.disconnect();
}
