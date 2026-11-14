// Real retained ownership assertions; fixture creation and profiling setup stay outside capture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";
import {
  writeGatewayGcTraceMarker,
  GATEWAY_HEAP_SAMPLE_INTERVAL,
  readGatewayGcTrace,
  readGatewayHeapProfile,
} from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "owner-dir": { type: "string" },
    operations: { type: "string", default: "2000" },
    "assertions-per-operation": { type: "string", default: "100" },
    "interval-ms": { type: "string", default: "10" },
    "warmup-operations": { type: "string", default: "100" },
    "start-file": { type: "string" },
    "gc-log": { type: "string" },
    allocations: { type: "boolean", default: false },
    output: { type: "string" },
    revision: { type: "string" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const integer = (raw: string | undefined, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, fallback: min, min });
const operations = integer(values.operations, "--operations");
const assertionsPerOperation = integer(
  values["assertions-per-operation"],
  "--assertions-per-operation",
);
const intervalMs = integer(values["interval-ms"], "--interval-ms", 0);
const warmupOperations = integer(values["warmup-operations"], "--warmup-operations", 0);
const assertionCount = operations * assertionsPerOperation;
assert(Number.isSafeInteger(assertionCount), "Assertion count exceeds the integer range");
const stateDir = path.resolve(values["state-dir"]);
const output = path.resolve(values.output);
const profilePath = `${output}.heapprofile`;
const startFile = values["start-file"] ? path.resolve(values["start-file"]) : undefined;
assert(!startFile || !existsSync(startFile), "--start-file must be absent before preparation");
const traced = process.execArgv.includes("--trace-gc-nvp");
assert(
  !values.allocations || !traced,
  "Run allocation sampling separately from the promotion pass",
);
assert(!values["gc-log"] || traced, "--gc-log requires --trace-gc-nvp");
const fixture: { format: string; sessionCount: number } = JSON.parse(
  readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8"),
);
assert.equal(
  fixture.format,
  "openclaw-team-shape-v1",
  "Use an existing synthetic team-shape fixture",
);
assert(existsSync(path.join(stateDir, "state", "openclaw.sqlite")), "Fixture database is missing");
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(path.join(stateDir, "home"), { recursive: true });
mkdirSync(path.join(stateDir, "tmp"), { recursive: true });
process.env = createGatewayBenchEnv(
  path.join(stateDir, "home"),
  path.join(stateDir, "openclaw.json"),
  {
    startupTrace: false,
    caseEnv: { OPENCLAW_STATE_DIR: stateDir, TMPDIR: path.join(stateDir, "tmp") },
  },
);

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownerRoot = values["owner-dir"] ? path.resolve(values["owner-dir"]) : sourceRoot;
const ownerFiles = [
  "src/infra/gateway-state-owner.ts",
  "src/infra/gateway-lock.ts",
  "src/infra/gateway-lock-payload.ts",
  "src/gateway/worker-environments/local-workspace-projection.ts",
];
const ownerSources = new Map(
  ownerFiles.map((file) => {
    const source = readFileSync(path.join(ownerRoot, file), "utf8");
    return [
      path.join(sourceRoot, file),
      {
        file,
        sha256: createHash("sha256").update(source).digest("hex"),
        source: transformSync(source, {
          loader: "ts",
          format: "esm",
          target: "esnext",
          sourcefile: file,
        }).code,
      },
    ];
  }),
);
const loadedOwners = new Set<string>();
// Both baseline and candidate use this same transform and retain canonical module identities.
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const replacement = url.startsWith("file:") ? ownerSources.get(fileURLToPath(url)) : undefined;
    if (!replacement) {
      return nextLoad(url, context);
    }
    loadedOwners.add(replacement.file);
    return { format: "module", source: replacement.source, shortCircuit: true };
  },
});
const marker = (phase: string) => {
  if (traced) {
    writeGatewayGcTraceMarker(phase, profilePath);
  }
};
if (traced) {
  assert(global.gc, "Promotion trace identification requires --expose-gc");
  marker("identify-start");
  global.gc();
  marker("identify-stop");
}

const { acquireGatewayLock } = await import("../../src/infra/gateway-lock.js");
const { captureGatewayStateOwner } = await import("../../src/infra/gateway-state-owner.js");
const lock = await acquireGatewayLock({ env: process.env, allowInTests: true });
assert(lock, "Gateway lock acquisition was skipped");
const inspector = new Session();
try {
  const owner = captureGatewayStateOwner(path.join(stateDir, "state", "openclaw.sqlite"));
  assert(owner, "Gateway state owner was not registered");
  for (const file of ownerFiles.slice(0, 3)) {
    assert(loadedOwners.has(file), `Owner overlay did not load: ${file}`);
  }
  const batch = () => {
    for (let index = 0; index < assertionsPerOperation; index++) {
      owner.assertCurrent();
    }
  };
  for (let index = 0; index < warmupOperations; index++) {
    batch();
    await delay(intervalMs);
  }
  if (values.allocations) {
    inspector.connect();
  }
  const latency = new Float64Array(operations);
  const ready = {
    pid: process.pid,
    preparedAtEpochMs: Date.now(),
    processAgeSeconds: process.uptime(),
  };
  writeFileSync(`${output}.ready`, `${JSON.stringify(ready)}\n`, { flag: "wx" });
  writeSync(1, `STATE_OWNER_READY ${JSON.stringify(ready)}\n`);
  let scheduledStartAtEpochMs: number | undefined;
  if (startFile) {
    const deadline = Date.now() + 600_000;
    while (!existsSync(startFile)) {
      assert(Date.now() < deadline, "Timed out waiting for --start-file");
      await delay(50);
    }
    scheduledStartAtEpochMs = integer(readFileSync(startFile, "utf8"), "--start-file epoch");
    assert(Date.now() < scheduledStartAtEpochMs, "Missed synchronized start after warmup");
    await delay(scheduledStartAtEpochMs - Date.now());
  }
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: GATEWAY_HEAP_SAMPLE_INTERVAL,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const stopDiagnostics = startGatewayBenchDiagnostics();
  const beforeCpu = process.cpuUsage();
  const beforeThreadCpu = process.threadCpuUsage();
  marker("diagnostics-start");
  const startedAt = performance.now();
  for (let index = 0; index < operations; index++) {
    const began = performance.now();
    batch();
    latency[index] = performance.now() - began;
    await delay(Math.max(0, startedAt + (index + 1) * intervalMs - performance.now()));
  }
  const durationMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(beforeCpu);
  const threadCpu = process.threadCpuUsage(beforeThreadCpu);
  const diagnostics = stopDiagnostics();
  marker("diagnostics-stop");
  assert.equal(diagnostics.collectionErrors, 0, "Diagnostic collection failed");
  let allocation;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    writeFileSync(profilePath, JSON.stringify(profile), { flag: "wx" });
    const heap = readGatewayHeapProfile(profilePath);
    allocation = {
      profilePath,
      scope: "main-isolate, including collected objects",
      samplingIntervalBytes: GATEWAY_HEAP_SAMPLE_INTERVAL,
      estimatedBytes: heap.sampledAllocatedBytes,
      estimatedBytesPerAssertion: heap.sampledAllocatedBytes / assertionCount,
      estimatedBytesPerMeasuredMinute: (heap.sampledAllocatedBytes * 60_000) / durationMs,
      topAllocationSites: heap.topAllocationSites,
    };
  }
  const promotion = values["gc-log"]
    ? readGatewayGcTrace(values["gc-log"], profilePath, "diagnostics")
    : undefined;
  const totalCpuMs = (cpu.user + cpu.system) / 1000;
  const mainThreadCpuMs = (threadCpu.user + threadCpu.system) / 1000;
  latency.sort();
  const result = {
    scope: "retained Gateway ownership assertion; no serving Gateway or workspace operations",
    mode: values.allocations ? "sampled-allocation" : traced ? "traced-promotion" : "untraced-cost",
    revision: values.revision,
    fixture,
    ownerSources: [...ownerSources.values()].map(({ file, sha256 }) => ({
      file,
      sha256,
      loaded: loadedOwners.has(file),
    })),
    operations,
    assertionsPerOperation,
    assertionCount,
    warmupOperations,
    intervalMs,
    ready,
    scheduledStartAtEpochMs,
    actualStartAtEpochMs: performance.timeOrigin + startedAt,
    durationMs,
    cpu: {
      totalMs: totalCpuMs,
      mainThreadMs: mainThreadCpuMs,
      totalUsPerAssertion: (totalCpuMs * 1000) / assertionCount,
      mainThreadUsPerAssertion: (mainThreadCpuMs * 1000) / assertionCount,
      totalMsPerMeasuredMinute: (totalCpuMs * 60_000) / durationMs,
      mainThreadMsPerMeasuredMinute: (mainThreadCpuMs * 60_000) / durationMs,
    },
    batchLatencyMs: {
      count: operations,
      p50: latency[Math.ceil(operations * 0.5) - 1],
      p95: latency[Math.ceil(operations * 0.95) - 1],
      p99: latency[Math.ceil(operations * 0.99) - 1],
      max: latency[operations - 1],
    },
    gcMsPerAssertion: (diagnostics.gc.durationMs?.total ?? 0) / assertionCount,
    diagnostics,
    allocation,
    promotion: promotion && {
      ...promotion,
      bytesPerAssertion: promotion.promotedBytes / assertionCount,
    },
  };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  writeSync(1, `STATE_OWNER_RESULT ${JSON.stringify(result)}\n`);
} finally {
  inspector.disconnect();
  await lock.release();
  hooks.deregister();
}
