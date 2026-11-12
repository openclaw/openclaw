// Owner-only synthetic safe-bin IO proof; no Gateway or persisted user state.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/exec-safe-bin-io-measure.mjs
// Run baseline/candidate checkouts in A/A/B order, five times, with --source-root.
// Repeat separately with --allocation and --counts; only default mode measures time.
// FS spies are installed only for --counts, never timing or allocation samples.
// Acceptance: disabled-policy FS work disappears and enabled preparation/admission
// makes zero main-thread sync FS calls, retaining the same wc trust verdict.
// Async bookkeeping can cost CPU/allocation; report that tradeoff explicitly.
// Counts are fs API calls per 18 operations, not kernel or elapsed-minute counts.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "source-root": { type: "string", default: fileURLToPath(new URL("../../", import.meta.url)) },
    allocation: { type: "boolean", default: false },
    counts: { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(!(values.counts && values.allocation), "Run --counts and --allocation separately");
assert(process.platform !== "win32", "This fixture requires /usr/bin/wc");
const ownerUrl = (name) =>
  pathToFileURL(path.resolve(values["source-root"], "src/infra", `${name}.ts`));
const policy = await import(ownerUrl("exec-safe-bin-runtime-policy").href);
const trust = await import(ownerUrl("exec-safe-bin-trust").href);
const inspector = new Session();
// Initialize Node's lazy clock before measuring CPU used by the owner.
performance.now();
if (values.allocation) {
  inspector.connect();
}
const counts = {};
const restorers = [];
function counted(original, key) {
  return Object.assign(function (...args) {
    counts[key] = (counts[key] ?? 0) + 1;
    return original.apply(this, args);
  }, original);
}
if (values.counts) {
  for (const { owner, methods, prefix } of [
    { owner: fs, methods: ["statSync", "accessSync", "realpathSync"], prefix: "main" },
    { owner: fsp, methods: ["stat", "access", "realpath"], prefix: "async" },
  ]) {
    for (const method of methods) {
      const original = owner[method];
      const key = `${prefix}.${method}`;
      const observed = counted(original, key);
      if (method === "realpathSync") {
        observed.native = counted(original.native, `${key}.native`);
      }
      owner[method] = observed;
      restorers.push(() => {
        owner[method] = original;
      });
    }
  }
}
try {
  for (const disabled of [true, false]) {
    const operation = async () => {
      const prepared = await policy.resolveExecSafeBinRuntimePolicy({
        local: disabled ? { safeBins: [] } : undefined,
      });
      if (!disabled) {
        assert(
          await trust.isTrustedSafeBinPath({
            resolvedPath: "/usr/bin/wc",
            trustedDirs: prepared.trustedSafeBinDirs,
          }),
        );
      }
    };
    for (let index = 0; index < 3; index++) {
      await operation();
    }
    global.gc();
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    for (const key of Object.keys(counts)) {
      delete counts[key];
    }
    const hostLoad = loadavg();
    const cpu = process.cpuUsage();
    const thread = process.threadCpuUsage();
    const started = performance.now();
    for (let index = 0; index < 18; index++) {
      await operation();
    }
    const wallMs = performance.now() - started;
    const mainCpu = process.threadCpuUsage(thread);
    const processCpu = process.cpuUsage(cpu);
    const calls = { ...counts };
    const profile = values.allocation
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    console.log(
      JSON.stringify({
        scenario: disabled ? "disabled" : "default-wc-admission",
        phase: "warm-process",
        operations: 18,
        mode: values.counts ? "counts" : values.allocation ? "allocation" : "timing",
        runtime: { node: process.version, bun: process.versions.bun ?? null },
        hostLoad,
        ...(values.counts
          ? { calls }
          : values.allocation
            ? {
                sampledAllocatedBytes: profile.samples.reduce(
                  (sum, sample) => sum + sample.size,
                  0,
                ),
              }
            : {
                wallMs,
                mainCpuUs: mainCpu.user + mainCpu.system,
                processCpuUs: processCpu.user + processCpu.system,
              }),
      }),
    );
  }
} finally {
  for (const restore of restorers) {
    restore();
  }
  inspector.disconnect();
}
