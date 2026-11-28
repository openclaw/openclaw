/**
 * Run under Node on a disposable Linux host with a delegated cgroup v2 mount.
 * node scripts/perf/host-memory-pressure-measure.mjs <base host-memory.ts> <head host-memory.ts>
 * Supply both source files with their normal package resolution. No files are changed here.
 * Acceptance: matching results, no warm mountinfo read, lower CPU and allocations than
 * the A/A spread, with five interleaved timing and allocation samples per arm.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [base, head] = process.argv.slice(2);
assert(process.platform === "linux" && base && head);
const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
const cgroupMount = mountinfo
  .split("\n")
  .findLast((line) => line.includes(" /sys/fs/cgroup ") && line.includes(" - cgroup2 "));
assert(cgroupMount && cgroupMount.split(" ")[3] !== "/", "Expected a delegated mount");
console.log(
  JSON.stringify({ mountinfoBytes: Buffer.byteLength(mountinfo), node: process.version }),
);

const checks = 10_000;
const inspector = new Session();
inspector.connect();
const read = fs.readFileSync;
for (const phase of ["timing", "allocation", "reads"]) {
  const order =
    phase === "reads"
      ? ["A", "B"]
      : Array.from({ length: 5 }, (_, i) =>
          i % 2 === 0 ? ["A", "A2", "A", "B"] : ["A2", "A", "B", "A"],
        ).flat();
  for (const [i, arm] of order.entries()) {
    const url = pathToFileURL(resolve(arm === "B" ? head : base));
    url.searchParams.set("sample", `${phase}-${i}`);
    const { isMemoryPressureHigh: check } = await import(url.href);
    const coldStart = performance.now();
    assert.equal(check(), false);
    const coldUs = (performance.now() - coldStart) * 1_000;
    for (let j = 0; j < 2_000; j++) {
      assert.equal(check(), false);
    }
    if (phase === "reads") {
      const reads = {};
      fs.readFileSync = (file, ...args) => {
        reads[file] = (reads[file] ?? 0) + 1;
        return read(file, ...args);
      };
      syncBuiltinESMExports();
      try {
        assert.equal(check(), false);
      } finally {
        fs.readFileSync = read;
        syncBuiltinESMExports();
      }
      console.log(JSON.stringify({ phase, arm, reads }));
      continue;
    }
    if (phase === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    let deferred = 0;
    const cpuStart = process.threadCpuUsage();
    const start = performance.now();
    for (let j = 0; j < checks; j++) {
      deferred += Number(check());
    }
    const wallUs = ((performance.now() - start) * 1_000) / checks;
    const cpu = process.threadCpuUsage(cpuStart);
    const allocatedBytes =
      phase === "allocation"
        ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
            (sum, sample) => sum + sample.size,
            0,
          ) / checks
        : undefined;
    assert.equal(deferred, 0);
    console.log(
      JSON.stringify({
        phase,
        arm,
        coldUs,
        wallUs,
        cpuUs: (cpu.user + cpu.system) / checks,
        allocatedBytes,
        load: loadavg(),
      }),
    );
  }
}
inspector.disconnect();
