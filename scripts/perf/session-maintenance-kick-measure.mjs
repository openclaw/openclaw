/**
 * Real maintenance scheduling and SQLite preparation on a synthetic 10k-row store.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-maintenance-kick-measure.mjs
 *   --output .local/maintenance-candidate --iterations 2000 --instrument timing
 * Add --revision <base-sha> to replace only the scheduling owner from that revision.
 * Run fresh processes in AB/BA order; allocation is a separate --instrument allocation pass.
 * Each round changes the age policy to require preparation, then acknowledges
 * one monotone activity write while that result is delivered. The real owner must
 * settle at its next age deadline. Only its private 1s retry is accelerated to 1ms;
 * wall time is harness throughput, never production latency. Work and CPU include
 * the ordinary write plus every required/redundant maintenance pass. Requests/min
 * use an explicit synthetic cadence of 12 rounds/min, not an observed Team rate.
 * This owner microbenchmark has no Gateway clients, model turns, or live state.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    revision: { type: "string" },
    iterations: { type: "string", default: "2000" },
    warmup: { type: "string", default: "10" },
    rows: { type: "string", default: "10000" },
    instrument: { type: "string", default: "timing" },
  },
});
assert(values.output && ["timing", "allocation"].includes(values.instrument));
const iterations = Number(values.iterations);
const warmup = Number(values.warmup);
const rows = Number(values.rows);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(warmup) && warmup >= 0);
assert(Number.isSafeInteger(rows) && rows >= 100);
const output = path.resolve(values.output);
const root = fileURLToPath(new URL("../../", import.meta.url));
fs.mkdirSync(output);
for (const name of ["home", "tmp", "state", "archives"]) {
  fs.mkdirSync(path.join(output, name));
}
const configPath = path.join(output, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    TMPDIR: path.join(output, "tmp"),
    DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
  },
});
fs.writeFileSync(
  configPath,
  JSON.stringify({
    agents: { entries: { main: { workspace: path.join(output, "home") } } },
    plugins: { enabled: false },
    cron: { enabled: false },
  }),
);
const ownerPath = "src/config/sessions/session-accessor.sqlite-maintenance-kick.ts";
let source = values.revision
  ? execFileSync("git", ["show", `${values.revision}:${ownerPath}`], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    })
  : fs.readFileSync(path.join(root, ownerPath), "utf8");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const replaceOnce = (before, after) => {
  assert.equal(source.split(before).length, 2, `Expected one instrumentation anchor: ${before}`);
  source = source.replace(before, after);
};
replaceOnce("const MAINTENANCE_WRITE_QUIET_MS = 1_000;", "const MAINTENANCE_WRITE_QUIET_MS = 1;");
replaceOnce(
  "      if (!planningConsumed) {",
  "      await globalThis.maintenanceMeasureDelivered(result);\n      if (!planningConsumed) {",
);
replaceOnce(
  "  // Bound relative delays: Node clamps overflowed timeouts to 1 ms.",
  "  globalThis.maintenanceMeasureScheduled(nextAt);\n  // Bound relative delays: Node clamps overflowed timeouts to 1 ms.",
);
registerHooks({
  load(url, context, nextLoad) {
    if (url !== new URL(ownerPath, `file://${root}`).href) {
      return nextLoad(url, context);
    }
    return {
      format: "module",
      source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
      shortCircuit: true,
    };
  },
});
let delivered;
let scheduled;
globalThis.maintenanceMeasureDelivered = async (result) => {
  assert.equal(result.kind, "maintenance-plan");
  assert.equal(result.value.archived, 0);
  assert.equal(result.value.entryRemovals.length, 0);
  await delivered?.();
};
globalThis.maintenanceMeasureScheduled = (at) => scheduled?.(at);
const agent = await import("../../src/state/openclaw-agent-db.ts");
const state = await import("../../src/state/openclaw-state-db.ts");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts");
const { kickSessionEntryMaintenanceAfterWrite: kick } =
  await import("../../src/config/sessions/session-accessor.sqlite-maintenance-kick.ts");
const { resolveMaintenanceConfigFromInput } =
  await import("../../src/config/sessions/store-maintenance.ts");
const { onInternalDiagnosticEvent, waitForDiagnosticEventsDrained } =
  await import("../../src/infra/diagnostic-events.ts");
const scope = {
  agentId: "main",
  env: process.env,
  path: path.join(output, "state", "agent.sqlite"),
};
console.error("maintenance measure: opening fixture");
const database = agent.openOpenClawAgentDatabase(scope);
const initialTime = Date.now();
const liveRows = 100;
const sessionKey = "agent:main:maintenance-0";
agent.runOpenClawAgentWriteTransaction((current) => {
  for (let index = 0; index < rows; index++) {
    writeSessionEntry(current, `agent:main:maintenance-${index}`, {
      sessionId: `maintenance-${index}`,
      updatedAt: initialTime,
      ...(index >= liveRows ? { archivedAt: initialTime, archiveReason: "age-retention" } : {}),
    });
  }
}, scope);
console.error("maintenance measure: fixture ready");
const policy = resolveMaintenanceConfigFromInput({
  mode: "enforce",
  pruneAfter: "30d",
  maxEntries: 1000,
});
const request = {
  activeSessionKey: sessionKey,
  archiveDirectory: path.join(output, "archives"),
  maintenanceConfig: { ...policy, archiveDashboardAfterMs: null, preserveRecentMs: null },
  scope,
  storePath: scope.path,
};
let ordinal = 0;
const runRound = async () => {
  const round = ordinal++;
  request.maintenanceConfig.pruneAfterMs = policy.pruneAfterMs + round;
  let wrote = false;
  const settled = Promise.withResolvers();
  const deadline = setTimeout(
    () => settled.reject(new Error("Maintenance round did not settle")),
    120_000,
  );
  scheduled = (at) => {
    assert(at > Date.now() + 60_000, "Expected a future maintenance deadline");
    settled.resolve();
  };
  delivered = () => {
    if (wrote) {
      return;
    }
    wrote = true;
    agent.runOpenClawAgentWriteTransaction((current) => {
      assert.equal(current.db, database.db);
      writeSessionEntry(current, sessionKey, {
        sessionId: "maintenance-0",
        updatedAt: Date.now(),
        label: `activity-${round}`,
      });
    }, scope);
    kick(request);
  };
  try {
    kick(request);
    await settled.promise;
    assert(wrote);
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    clearTimeout(deadline);
    scheduled = undefined;
    delivered = undefined;
  }
};
let stopDiagnostics = () => {};
try {
  for (let index = 0; index < warmup; index++) {
    await runRound();
  }
  await waitForDiagnosticEventsDrained();
  const requests = {};
  stopDiagnostics = onInternalDiagnosticEvent(
    (event) => {
      if (
        event.type === "worker.request" &&
        event.phase === "completed" &&
        (event.requestClass.startsWith("session.maintenance.") ||
          event.requestClass.startsWith("stateLease."))
      ) {
        requests[event.requestClass] = (requests[event.requestClass] ?? 0) + 1;
      }
    },
    { include: ["worker.request"] },
  );
  globalThis.gc?.();
  const inspector = values.instrument === "allocation" ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  let gcMs = 0;
  let gcCount = 0;
  let maxGcMs = 0;
  const gc = new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) {
      gcMs += entry.duration;
      gcCount++;
      maxGcMs = Math.max(maxGcMs, entry.duration);
    }
  });
  gc.observe({ entryTypes: ["gc"] });
  const hostLoad = loadavg();
  const before = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    await runRound();
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.threadCpuUsage(before);
  await waitForDiagnosticEventsDrained();
  let sampledAllocationBytes;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledAllocationBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
    inspector.disconnect();
  }
  gc.disconnect();
  const report = {
    revision: values.revision ?? "working-tree",
    sourceSha256,
    iterations,
    warmup,
    fixture: { rows, liveRows, archivedRows: rows - liveRows },
    instrument: values.instrument,
    elapsedMs,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    cpuMsPerRound: (cpu.user + cpu.system) / 1000 / iterations,
    sampledAllocationBytes,
    allocationBytesPerRound:
      sampledAllocationBytes === undefined ? undefined : sampledAllocationBytes / iterations,
    gcMs,
    gcCount,
    maxGcMs,
    gcMsPerRound: gcMs / iterations,
    gcMsPerSimulatedMinute: (gcMs * 12) / iterations,
    hostLoad,
    hostLoadEnd: loadavg(),
    memory: process.memoryUsage(),
    requests,
    requestsPerSimulatedMinute: Object.fromEntries(
      Object.entries(requests).map(([key, count]) => [key, (count * 12) / iterations]),
    ),
    simulatedRoundsPerMinute: 12,
  };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  stopDiagnostics();
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
  await (await import("../../src/shared/global-singleton.ts")).drainGlobalSingletonLifecycleState();
}
