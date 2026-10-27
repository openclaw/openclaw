/**
 * Cold native preparation alongside retained sibling writes, using real SQLite workers.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-prepare-write-measure.mjs
 *   --source <saved-openclaw-agent-execution.worker.ts> --mode timing|allocation --iterations 20
 *
 * --workload owner --iterations 5000 [--baseline] measures only the removed
 * repeated schema computation on the same admitted real database, excluding IPC.
 * Run baseline/candidate in AB/BA order. A task-local backend wrapper replaces only
 * the requested worker source; the production native generation, broker, admission,
 * SQL, and cleanup execute unchanged. Seed 10,000 sessions once, then each iteration
 * opens/prepares/closes one native generation while a retained sibling database writes.
 * Acceptance: identical committed row hashes and preparation counts, less CPU or
 * allocation, and no material adverse aggregate transcript queue wait in timing passes.
 * Cold and sibling writes share the transcript request class; queue tails combine both.
 * Allocation runs separately and covers the main thread only; retiring workers are
 * not sampled. Process CPU includes all workers and cleanup. This intentionally
 * exercises cold-generation churn; it does not infer its production frequency or
 * claim whole-Gateway throughput. All state is synthetic under .local and removed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "src/state/openclaw-agent-execution.worker.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string" },
    workload: { type: "string", default: "mix" },
    baseline: { type: "boolean", default: false },
    sessions: { type: "string", default: "10000" },
  },
});
const iterations = Number(values.iterations ?? (values.workload === "owner" ? "5000" : "20"));
assert(["owner", "mix"].includes(values.workload));
const sessions = Number(values.sessions);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(sessions) && sessions >= 0);
assert(["timing", "allocation"].includes(values.mode));
assert(globalThis.gc, "Use --expose-gc");
const source = fs.readFileSync(values.source, "utf8");
fs.mkdirSync(".local", { recursive: true });
const root = fs.mkdtempSync(path.resolve(".local/agent-prepare-write-"));
process.env.OPENCLAW_STATE_DIR = root;
const env = { OPENCLAW_STATE_DIR: root };
const ownerUrl = pathToFileURL(path.resolve("src/state/openclaw-agent-execution.worker.ts")).href;
const wrapper = path.join(root, "backend.mjs");
// The production carrier supplies its own execArgv, so install the source hook
// inside its imported backend rather than relying on an inherited preload.
fs.writeFileSync(
  wrapper,
  `import { registerHooks, stripTypeScriptTypes } from 'node:module';
const target = ${JSON.stringify(ownerUrl)};
let replaced = false;
const hook = registerHooks({load(url, context, nextLoad) {
  if (url === target) {
    replaced = true;
    return {format: 'module', source: stripTypeScriptTypes(${JSON.stringify(source)}, {mode: 'strip'}), shortCircuit: true};
  }
  return nextLoad(url, context);
}});
const backend = await import(target);
hook.deregister();
if (!replaced) throw new Error('Requested worker source was not loaded');
export const createSqliteWorkerBackend = backend.createSqliteWorkerBackend;
export const openExistingSqliteWorkerBackend = backend.openExistingSqliteWorkerBackend;
`,
);

const { applyLoggingConfig } = await import("../../src/logging/logger.ts");
applyLoggingConfig({
  level: "error",
  file: path.join(root, "measure.log"),
  consoleLevel: "silent",
});
const { runtimeProcessEntrypoints } =
  await import("../../src/infra/runtime-process-entrypoints.ts");
const entry = runtimeProcessEntrypoints.agentDatabaseExecution;
const originalEntry = { ...entry };
Object.assign(entry, {
  currentModuleUrl: pathToFileURL(wrapper).href,
  sourceWorkerName: "backend",
  sourceExtension: ".mjs",
});
const { acquireGatewayStateOwner } = await import("../../src/infra/gateway-state-owner.ts");
const { readGatewayLockProcessNamespace } = await import("../../src/infra/gateway-lock-payload.ts");
const { readDatabasePathIdentitySync } = await import("../../src/infra/sqlite-worker-identity.ts");
const { createSqliteWorkerOperationAdmission } =
  await import("../../src/infra/sqlite-worker-operation-admission.ts");
const { setDiagnosticsEnabledForProcess } = await import("../../src/infra/diagnostic-events.ts");
const { onWorkerRequestMetrics } = await import("../../src/infra/worker-request-diagnostics.ts");
const { getWorkerMessageMetrics } = await import("../../src/infra/worker-message-metrics.ts");
const { createAgentDatabaseNativeGeneration } =
  await import("../../src/state/openclaw-agent-execution-native.ts");
const { AgentDatabaseExecutionLifetime } =
  await import("../../src/state/openclaw-agent-execution-authority.ts");
const { captureOpenClawStateWorkerContext } =
  await import("../../src/state/openclaw-state-worker-context.ts");
const {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} = await import("../../src/state/openclaw-agent-db.ts");
const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.ts");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts");
const statePath = path.join(root, "state", "openclaw.sqlite");
fs.mkdirSync(path.dirname(statePath), { recursive: true });
const owner = acquireGatewayStateOwner({
  databasePath: statePath,
  payload: {
    pid: process.pid,
    role: "gateway",
    createdAt: new Date().toISOString(),
    configPath: path.join(root, "openclaw.json"),
    processNamespace: readGatewayLockProcessNamespace(),
  },
});
const workers = new Set();
const observeWorker = (worker) => workers.add(worker);
process.on("worker", observeWorker);
const inspector = new Session();
let sibling;
let unsubscribe;
const noop = () => {};
const sourceAuthority = {
  assertCurrent: noop,
  createAdmission(binding) {
    return () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        assert(grant(), "Synthetic writer admission lost custody");
      }, binding.attachment),
    });
  },
};
const sampledBytes = (profile) => {
  let total = 0;
  const pending = [profile.head];
  while (pending.length) {
    const node = pending.pop();
    total += node.selfSize;
    pending.push(...node.children);
  }
  return total;
};
const cpuMs = (usage) => (usage.user + usage.system) / 1000;
const summarize = (samples) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: samples.length,
    totalMs: samples.reduce((sum, value) => sum + value, 0),
    p99Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0,
  };
};
try {
  openOpenClawStateDatabase({ env });
  const paths = new Map();
  for (const agentId of ["cold", "sibling"]) {
    const options = { agentId, env };
    const database = openOpenClawAgentDatabase(options);
    paths.set(agentId, database.path);
    if (agentId === "cold") {
      runOpenClawAgentWriteTransaction((current) => {
        for (let i = 0; i < sessions; i++) {
          writeSessionEntry(current, `agent:cold:subagent:seed-${i}`, {
            sessionId: `seed-${i}`,
            updatedAt: i + 1,
          });
        }
      }, options);
    }
    closeOpenClawAgentDatabaseByPath(database.path);
  }
  if (values.workload === "owner") {
    const { getOpenClawAgentDatabaseValidation } =
      await import("../../src/state/openclaw-agent-db-validation-cache.ts");
    const { refreshOpenClawAgentDatabaseSchema } =
      await import("../../src/state/openclaw-agent-db-schema-refresh.ts");
    const database = openOpenClawAgentDatabase({ agentId: "cold", env });
    const prepare = () => {
      const validation = getOpenClawAgentDatabaseValidation(database);
      assert(validation);
      if (values.baseline) {
        refreshOpenClawAgentDatabaseSchema(database, noop);
      }
      return validation;
    };
    for (let i = 0; i < 100; i++) {
      prepare();
    }
    globalThis.gc();
    if (values.mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 512,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoadBefore = loadavg();
    const beforeCpu = process.threadCpuUsage();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      prepare();
    }
    const elapsedMs = performance.now() - start;
    const usedCpuMs = cpuMs(process.threadCpuUsage(beforeCpu));
    let allocatedBytes;
    if (values.mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocatedBytes = sampledBytes(profile);
    }
    const rows = database.db
      .prepare("SELECT session_key, current_session_id FROM session_nodes ORDER BY session_key")
      .all();
    assert.equal(rows.length, sessions);
    console.log(
      JSON.stringify({
        workload: "owner",
        baseline: values.baseline,
        mode: values.mode,
        iterations,
        seededSessions: sessions,
        elapsedMs,
        cpuMs: usedCpuMs,
        allocatedBytes,
        bytesPerIteration: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
        committed: {
          rows: rows.length,
          sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
        },
        coverage: "owner computation only; excludes saved host admission roundtrip",
      }),
    );
    closeOpenClawAgentDatabaseByPath(database.path);
  } else {
    const context = captureOpenClawStateWorkerContext({ env });
    const generation = (agentId) => {
      const pathname = paths.get(agentId);
      const identity = readDatabasePathIdentitySync(pathname);
      return createAgentDatabaseNativeGeneration(
        agentId,
        pathname,
        context,
        new AgentDatabaseExecutionLifetime().state,
        () => context.admission.assertCurrent(),
        () => context.admission.assertCurrent(),
        {
          kind: "file",
          physicalIdentity: identity.key.slice("file:".length),
          birthtime: identity.birthtime,
          nativeLocation: identity.canonicalPath,
        },
        noop,
        (error) => {
          throw error;
        },
      );
    };
    const write = (native, agentId, id) =>
      native.run(
        sourceAuthority,
        (scope) =>
          scope.execute({
            type: "session.transcript.initialize",
            input: { sessionKey: `agent:${agentId}:measured-${id}`, sessionId: `measured-${id}` },
          }),
        undefined,
        true,
      );
    sibling = generation("sibling");
    await write(sibling, "sibling", "warm");
    const cycle = async (id) => {
      const cold = generation("cold");
      try {
        await Promise.all([write(cold, "cold", id), write(sibling, "sibling", id)]);
      } finally {
        await cold.close();
      }
    };
    for (let i = 0; i < 3; i++) {
      await cycle(`warm-${i}`);
    }
    const measuredWorkers = [...workers].filter((worker) => worker.threadId !== -1);
    measuredWorkers.forEach((worker) => worker.ref());
    const observations = new Map();
    setDiagnosticsEnabledForProcess(true);
    unsubscribe = onWorkerRequestMetrics(
      (kind, requestClass, phase, _depth, _wait, duration, timing) => {
        if (kind !== "sqlite_writer" || phase !== "completed") {
          return;
        }
        let record = observations.get(requestClass);
        if (!record) {
          observations.set(requestClass, (record = { execute: [], queue: [], request: [] }));
        }
        if (duration !== undefined) {
          record.request.push(duration);
        }
        if (timing?.executeStarted !== undefined && timing.executeFinished !== undefined) {
          record.execute.push(timing.executeFinished - timing.executeStarted);
        }
        if (timing?.enqueued !== undefined && timing.dispatched !== undefined) {
          record.queue.push(timing.dispatched - timing.enqueued);
        }
      },
    );
    globalThis.gc();
    if (values.mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoadBefore = loadavg();
    const beforeMemory = process.memoryUsage();
    const beforeWorkers = await Promise.all(measuredWorkers.map((worker) => worker.cpuUsage()));
    const beforeMessages = getWorkerMessageMetrics();
    const beforeMain = process.threadCpuUsage();
    const beforeProcess = process.cpuUsage();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await cycle(i);
    }
    const elapsedMs = performance.now() - start;
    const mainCpuMs = cpuMs(process.threadCpuUsage(beforeMain));
    const processCpuMs = cpuMs(process.cpuUsage(beforeProcess));
    const workerCpu = await Promise.all(
      measuredWorkers.map((worker, i) => worker.cpuUsage(beforeWorkers[i])),
    );
    const afterMemory = process.memoryUsage();
    const afterMessages = getWorkerMessageMetrics();
    const hostLoadAfter = loadavg();
    unsubscribe();
    unsubscribe = undefined;
    let allocation;
    if (values.mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const hostBytes = sampledBytes(profile);
      allocation = {
        hostBytes,
        hostBytesPerIteration: hostBytes / iterations,
        workerCoverage: "not measured",
      };
    }
    assert.equal(observations.get("database.prepareWrite")?.request.length, iterations);
    await sibling.close();
    sibling = undefined;
    const committed = {};
    for (const agentId of ["cold", "sibling"]) {
      const database = openOpenClawAgentDatabase({ agentId, env });
      const rows = database.db
        .prepare("SELECT session_key, current_session_id FROM session_nodes ORDER BY session_key")
        .all();
      const expected = iterations + (agentId === "cold" ? sessions + 3 : 4);
      assert.equal(rows.length, expected);
      committed[agentId] = {
        rows: rows.length,
        sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
      };
      closeOpenClawAgentDatabaseByPath(database.path);
    }
    console.log(
      JSON.stringify({
        source: values.source,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        workload: values.workload,
        mode: values.mode,
        workerMessages: afterMessages
          .filter((metric) => metric.kind === "admission" || metric.kind === "authority")
          .map((metric) => ({
            kind: metric.kind,
            direction: metric.direction,
            messages:
              metric.messages -
              (beforeMessages.find(
                (previous) =>
                  previous.kind === metric.kind && previous.direction === metric.direction,
              )?.messages ?? 0),
          })),
        iterations,
        seededSessions: sessions,
        measuredWorkers: measuredWorkers.length,
        elapsedMs,
        mainCpuMs,
        retainedWorkerCpuMs: workerCpu.reduce((sum, value) => sum + cpuMs(value), 0),
        processCpuMs,
        allocation,
        hostLoadBefore,
        hostLoadAfter,
        beforeMemory,
        afterMemory,
        committed,
        requests: Object.fromEntries(
          [...observations].map(([name, record]) => [
            name,
            {
              execute: summarize(record.execute),
              queue: summarize(record.queue),
              request: summarize(record.request),
              executeSecondsPerMinute: (summarize(record.execute).totalMs * 60) / elapsedMs,
            },
          ]),
        ),
      }),
    );
  }
} finally {
  unsubscribe?.();
  inspector.disconnect();
  await sibling?.close();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  owner.release();
  Object.assign(entry, originalEntry);
  process.removeListener("worker", observeWorker);
  for (const worker of workers) {
    worker.unref();
  }
  fs.rmSync(root, { recursive: true, force: true });
}
