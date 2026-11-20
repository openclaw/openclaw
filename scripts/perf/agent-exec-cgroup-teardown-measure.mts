/**
 * Synthetic cgroupfs contract/owner-cost replay, not a kernel reclaim benchmark.
 * Run with pnpm exec tsx scripts/perf/agent-exec-cgroup-teardown-measure.mts.
 * 48 leaves, 46 empty, 29.5 GB charged (largest 17.9 GB); 4,000 session names.
 * Baseline is the original absent teardown operation, verified by the red
 * supervisor regression. The fixture models reclaim success, not btrfs latency.
 * No database or workspace is read by this owner; no real sysfs is accessed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { reclaimAgentExecCgroup } from "../../src/process/linux-exec-cgroup.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const original = {
  writeFile: fs.promises.writeFile,
  rmdir: fs.promises.rmdir,
};
const directories = Array.from(
  { length: 4_000 },
  (_, index) => `/synthetic/agent-exec/session-${index.toString(16).padStart(32, "0")}`,
);
const pending = directories.slice(0, 48);
const states = new Map<string, { live: boolean; bytes: number }>();
let reads = 0;
let writes = 0;
let removals = 0;
let activeWrites = 0;
let peakWrites = 0;
const inspector = new Session();
inspector.connect();
Object.defineProperty(process, "platform", { value: "linux", configurable: true });
// These filesystem methods are replaced only inside this standalone proof process.
mock.method(fs.promises, "readFile", async (file: string) => {
  reads++;
  const location = file;
  const state = states.get(path.dirname(location));
  assert(state, `unexpected read ${location}`);
  switch (path.basename(location)) {
    case "cgroup.events":
      return `populated ${state.live ? 1 : 0}\nfrozen 0\n`;
    case "cgroup.procs":
      return state.live ? "123\n" : "";
    case "memory.current":
      return String(state.bytes);
    default:
      throw new Error(`unexpected read ${location}`);
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
  // One warmup, five alternating baseline/candidate pairs, then five A/A pairs.
  const modes = [
    "warmup",
    ...Array.from({ length: 5 }, () => ["before", "after"]).flat(),
    ...Array.from({ length: 5 }, () => ["control-a", "control-a2"]).flat(),
  ];
  for (const [sample, mode] of modes.entries()) {
    states.clear();
    pending.forEach((directory, index) =>
      states.set(directory, {
        live: index >= 46,
        bytes:
          index === 0 ? 17_900_000_000 : index < 46 ? Math.floor(11_600_000_000 / 45) : 1024 ** 3,
      }),
    );
    reads = writes = removals = activeWrites = peakWrites = 0;
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const cpu = process.cpuUsage();
    const start = performance.now();
    await Promise.all(
      pending.map((directory) =>
        mode === "before" ? Promise.resolve() : reclaimAgentExecCgroup(directory),
      ),
    );
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const deadBytes = [...states.values()]
      .filter((state) => !state.live)
      .reduce((sum, state) => sum + state.bytes, 0);
    assert.equal(removals, mode === "before" ? 0 : 46);
    assert.equal(states.get(pending[46]!)!.bytes, 1024 ** 3);
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
        deadBytes,
        load: loadavg(),
      }),
    );
  }
} finally {
  mock.restoreAll();
  Object.assign(fs.promises, original);
  Object.defineProperty(process, "platform", originalPlatform);
  inspector.disconnect();
}
