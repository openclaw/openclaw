// Native Node owner benchmark; no build, Gateway, or persisted state required.
// node --expose-gc scripts/perf/exec-policy-sort-measure.mjs --mode timing
// Repeat with --mode allocation; sampled timings are not performance evidence.
// Save a baseline's exec-approval-policy-snapshot.ts with git show, then pass
// --owner-file <path>. Alternate base/candidate order for at least five pairs.
// Each run canonicalizes 32/128/512 shuffled synthetic rules, with repeated
// command patterns, argument constraints, optional sources, and Unicode.
// Acceptance: identical output, zero comparator Buffer allocations, lower
// sampled allocation and untraced CPU per snapshot. This is owner cost only.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    "owner-file": { type: "string" },
  },
});
assert(["timing", "allocation"].includes(values.mode));
assert(globalThis.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const owner = values["owner-file"]
  ? pathToFileURL(resolve(values["owner-file"]))
  : new URL("../../src/infra/exec-approval-policy-snapshot.ts", import.meta.url);
const { canonicalizeExecApprovalPolicyRules: canonicalize } = await import(owner.href);
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
}
for (const size of [32, 128, 512]) {
  const rules = Array.from({ length: size }, (_, index) => ({
    pattern: `/synthetic/tools/${["git", "rg", "node", "café", "工具", "\u{10000}"][index % 6]}`,
    argPattern: index % 4 === 0 ? undefined : `^--project=${index}\\s.*$`,
    source: index % 3 === 0 ? "allow-always" : undefined,
  }));
  let seed = 148;
  for (let index = rules.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [rules[index], rules[other]] = [rules[other], rules[index]];
  }
  const uniqueRules = canonicalize(rules).length;
  let checksum = 0;
  function run(count) {
    for (let index = 0; index < count; index++) {
      const result = canonicalize(rules);
      checksum += result.length;
    }
  }
  run(500);
  globalThis.gc();
  await nextTurn();
  const collections = [];
  const observer = new PerformanceObserver((batch) => collections.push(...batch.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  if (values.mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const beforeMemory = process.memoryUsage();
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  run(iterations);
  const ended = performance.now();
  const cpu = process.threadCpuUsage(cpuStart);
  const afterMemory = process.memoryUsage();
  // GC observations are delivered asynchronously after the synchronous workload.
  await nextTurn();
  await nextTurn();
  collections.push(...observer.takeRecords());
  observer.disconnect();
  const pauses = collections
    .filter((entry) => entry.startTime >= started && entry.startTime < ended)
    .map((entry) => entry.duration);
  const profile =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  console.log(
    JSON.stringify({
      mode: values.mode,
      node: process.version,
      rules: size,
      uniqueRules,
      iterations,
      hostLoad,
      wallMs: ended - started,
      mainThreadCpuUsPerSnapshot: (cpu.user + cpu.system) / iterations,
      sampledBytesPerSnapshot: profile
        ? profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations
        : undefined,
      allocationSamples: profile?.samples.length,
      gc: {
        count: pauses.length,
        totalMs: pauses.reduce((sum, ms) => sum + ms, 0),
        maxMs: Math.max(0, ...pauses),
      },
      beforeMemory,
      afterMemory,
      checksum,
    }),
  );
}
inspector.disconnect();
