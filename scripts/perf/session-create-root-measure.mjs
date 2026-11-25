/**
 * Session-root preparation against an existing synthetic workspace (read-only):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-create-root-measure.mjs \
 *   --workspace /absolute/synthetic/inventory --source /absolute/checkout/src/gateway/server-methods/session-create-root.ts \
 *   --mode timing --iterations 1000
 * Run A/A/B/A in separate processes; count, timing and allocation passes are separate.
 * These are owner filesystem API calls, not kernel syscall or whole-Gateway counts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import asyncFs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    source: { type: "string", default: "src/gateway/server-methods/session-create-root.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "1000" },
  },
});
assert(values.workspace, "--workspace must identify an existing synthetic fixture");
assert(["counts", "timing", "allocations"].includes(values.mode), "Unknown --mode");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 1000,
});
const workspace = await asyncFs.realpath(values.workspace);
const source = path.resolve(values.source);
const ownerHash = createHash("sha256")
  .update(await asyncFs.readFile(source))
  .digest("hex");
const { prepareSessionCreateFilesystemRoot: prepare } = await import(pathToFileURL(source).href);
const input = {
  cfg: { agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: { workspace } } } },
  targetAgentId: "main",
  enforceSandboxContainment: true,
  sandboxRequired: true,
  sessionCwd: workspace,
};
async function run(count) {
  for (let index = 0; index < count; index++) {
    const result = await prepare(input);
    assert.equal(result.ok, true);
    assert.equal(result.value.sessionRoot, workspace);
  }
}
await run(100);
global.gc();
const counts = {};
const restores = [];
if (values.mode === "counts") {
  for (const [owner, names] of [
    [fs, ["mkdirSync", "realpathSync", "statSync", "lstatSync"]],
    [asyncFs, ["mkdir", "realpath", "stat", "lstat"]],
  ]) {
    for (const name of names) {
      const original = owner[name];
      counts[name] = 0;
      owner[name] = new Proxy(original, {
        apply(method, receiver, args) {
          if (args[0] === workspace) {
            counts[name]++;
          }
          return Reflect.apply(method, receiver, args);
        },
      });
      restores.push(() => {
        owner[name] = original;
      });
    }
  }
}
const inspector = values.mode === "allocations" ? new Session() : undefined;
inspector?.connect();
await inspector?.post("HeapProfiler.startSampling", {
  samplingInterval: 4096,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
const hostLoad = loadavg();
const memoryBefore = process.memoryUsage();
const cpuBefore = process.cpuUsage();
const threadBefore = process.threadCpuUsage();
const started = performance.now();
try {
  await run(iterations);
  const elapsedMs = performance.now() - started;
  const mainCpu = process.threadCpuUsage(threadBefore);
  const totalCpu = process.cpuUsage(cpuBefore);
  const profile = (await inspector?.post("HeapProfiler.stopSampling"))?.profile;
  console.log(
    JSON.stringify({
      mode: values.mode,
      ownerSha256: ownerHash,
      iterations,
      hostLoad,
      counts: values.mode === "counts" ? counts : undefined,
      elapsedMs,
      mainCpuUsPerOperation: (mainCpu.user + mainCpu.system) / iterations,
      totalCpuUsPerOperation: (totalCpu.user + totalCpu.system) / iterations,
      allocatedBytesPerOperation: profile
        ? sumSampledHeapBytes(profile.head) / iterations
        : undefined,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
    }),
  );
} finally {
  inspector?.disconnect();
  for (const restore of restores) {
    restore();
  }
}
