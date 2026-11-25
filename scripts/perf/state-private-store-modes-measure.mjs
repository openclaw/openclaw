// Owner-only proof: real shared-state commits; sibling sizes do not affect permission repair.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/state-private-store-modes-measure.mjs
//   --output .local/result.json [--owner-source saved-baseline.ts] [--allocations|--counts]
// Run A/A controls and five interleaved A/B pairs. --allocations adds a separate
// post-timing pass in the same process; --counts is a separate instrumented run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "owner-source": { type: "string" },
    allocations: { type: "boolean", default: false },
    counts: { type: "boolean", default: false },
    iterations: { type: "string", default: "2000" },
  },
});
assert(values.output, "--output required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const output = path.resolve(values.output);
fs.mkdirSync(path.dirname(output), { recursive: true });
const fixture = fs.mkdtempSync(path.join(path.dirname(output), "private-modes-"));
const env = { OPENCLAW_STATE_DIR: fixture };
process.env.OPENCLAW_STATE_DIR = fixture;
process.env.OPENCLAW_CONFIG_PATH = path.join(fixture, "openclaw.json");
const target = fileURLToPath(
  new URL("../../src/state/openclaw-state-db-permissions.ts", import.meta.url),
);
const source = fs.readFileSync(values["owner-source"] ?? target, "utf8");
let loaded = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && fileURLToPath(url) === target) {
      loaded = true;
      return {
        format: "module",
        source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const { writeConfigMachineState } = await import("../../src/state/config-machine-state-write.ts");
const { readConfigMachineState } = await import("../../src/state/config-machine-state.ts");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
const inspector = new Session();
const originalOpen = fs.openSync;
const opens = {};
let observing = false;
const latencies = new Float64Array(iterations);
try {
  writeConfigMachineState("synthetic.permissions", 0, { env });
  assert(loaded, "Permission owner overlay did not load");
  for (const [directory, file] of [
    ["client", "credentials.sqlite"],
    ["control", "services.sqlite"],
  ]) {
    fs.mkdirSync(path.join(fixture, directory), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(fixture, directory, file), "opaque synthetic store", {
      mode: 0o600,
    });
  }
  fs.mkdirSync(`${fixture}.update-captures`, { mode: 0o700 });
  if (values.counts) {
    fs.openSync = function (file, ...args) {
      if (observing) {
        const relative = path.relative(fixture, String(file));
        if (
          /^(client|control)(\/|$)/u.test(relative) ||
          String(file) === `${fixture}.update-captures`
        ) {
          opens[relative] = (opens[relative] ?? 0) + 1;
        }
      }
      return Reflect.apply(originalOpen, fs, [file, ...args]);
    };
  }
  syncBuiltinESMExports();
  for (let index = 0; index < 100; index++) {
    writeConfigMachineState("synthetic.permissions", index, { env });
  }
  globalThis.gc?.();
  const hostLoad = loadavg();
  const beforeCpu = process.cpuUsage();
  const beforeThread = process.threadCpuUsage();
  const started = performance.now();
  observing = true;
  for (let index = 0; index < iterations; index++) {
    const began = performance.now();
    writeConfigMachineState("synthetic.permissions", index, { env });
    latencies[index] = performance.now() - began;
    if (index % 100 === 99) {
      await setImmediate();
    }
  }
  observing = false;
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(beforeCpu);
  const thread = process.threadCpuUsage(beforeThread);
  let allocatedBytes;
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let index = 0; index < iterations; index++) {
      writeConfigMachineState("synthetic.permissions", index, { env });
      if (index % 100 === 99) {
        await setImmediate();
      }
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const pending = [profile.head];
    allocatedBytes = 0;
    while (pending.length) {
      const node = pending.pop();
      allocatedBytes += node.selfSize;
      pending.push(...node.children);
    }
    fs.writeFileSync(`${output}.heapprofile`, JSON.stringify(profile), { flag: "wx" });
  }
  assert.equal(readConfigMachineState("synthetic.permissions", { env }), iterations - 1);
  for (const [directory, file] of [
    ["client", "credentials.sqlite"],
    ["control", "services.sqlite"],
  ]) {
    const store = path.join(fixture, directory, file);
    assert.equal(fs.readFileSync(store, "utf8"), "opaque synthetic store");
    assert.equal(fs.statSync(store).mode & 0o777, 0o600);
  }
  latencies.sort();
  const result = {
    scope: "warm shared-state write owner; small synthetic fixture; no serving Gateway",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    runtime: process.version,
    hostLoad,
    iterations,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    threadCpuMs: (thread.user + thread.system) / 1000,
    p50Ms: latencies[Math.ceil(iterations * 0.5) - 1],
    p95Ms: latencies[Math.ceil(iterations * 0.95) - 1],
    siblingOpens: values.counts
      ? Object.values(opens).reduce((sum, count) => sum + count, 0)
      : undefined,
    opens: values.counts ? opens : undefined,
    allocatedBytes,
  };
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(result));
} finally {
  observing = false;
  fs.openSync = originalOpen;
  syncBuiltinESMExports();
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
  hooks.deregister();
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(`${fixture}.update-captures`, { recursive: true, force: true });
}
