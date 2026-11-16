// Warm captured-target patches through the real agent worker with 5,000 synthetic rows.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-entry-patch-admission-measure.mjs
//   --checkout <baseline-or-candidate> --root <new-synthetic-directory>
//   --iterations 200 --mode count|timing|allocation
// Count separately; alternate A1/B/A2 five times for timing and sampled allocation.
// Timing/allocation use the original filesystem builtins. Counts cover main-thread DB stats;
// whole-Gateway filesystem counts and syscall stacks require the Gateway workload.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    checkout: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "1000" },
  },
});
assert(values.root && global.gc, "Use --root and --expose-gc");
assert(["count", "timing", "allocation"].includes(values.mode));
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = path.resolve(values.root);
fs.mkdirSync(root);
process.env.OPENCLAW_STATE_DIR = root;
assert(values.checkout);
const checkout = path.resolve(values.checkout);
const load = (relative) => import(pathToFileURL(path.join(checkout, relative)).href);
const source = [
  "src/config/sessions/session-entry-patch-source.ts",
  "src/config/sessions/session-accessor.sqlite-replacement-worker.ts",
  "src/state/openclaw-agent-execution.worker.ts",
]
  .map((name) => fs.readFileSync(path.join(checkout, name), "utf8"))
  .join("\n");
const { applyLoggingConfig, flushLogger } = await load("src/logging/logger.ts");
applyLoggingConfig({
  level: "error",
  file: path.join(root, "measure.log"),
  consoleLevel: "silent",
});
const {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} = await load("src/state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabaseAsync } = await load("src/state/openclaw-state-db.ts");
const { writeSessionEntry } = await load(
  "src/config/sessions/session-accessor.sqlite-entry-store.ts",
);
const { captureOpenClawAgentDatabaseExecution: capture } = await load(
  "src/state/openclaw-agent-execution.ts",
);
const { createSqliteWorkerOperationAdmission } = await load(
  "src/infra/sqlite-worker-operation-admission.ts",
);
const { patchSessionEntryTarget } = await load(
  "src/config/sessions/session-accessor.sqlite-entry.ts",
);
const { readSessionEntryInWorker } = await load(
  "src/config/sessions/session-entry-read-writable.ts",
);
const options = { agentId: "synthetic", env: { OPENCLAW_STATE_DIR: root } };
const seeded = openOpenClawAgentDatabase(options);
runOpenClawAgentWriteTransaction((database) => {
  for (let i = 0; i < 5000; i++) {
    writeSessionEntry(database, `agent:synthetic:session-${i}`, {
      sessionId: `synthetic-${i}`,
      updatedAt: i + 1,
    });
  }
}, options);
await closeOpenClawAgentDatabasesAsync();
const requestSource = {
  assertCurrent() {},
  createAdmission(binding) {
    return () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        assert(grant());
      }, binding.attachment),
    });
  },
};
const retained = capture(options);
let syncCalls = 0;
const stat = fs.statSync;
let target;
let sequence = 0;
const cycle = async () => {
  const label = `patch-${++sequence}`;
  const result = await patchSessionEntryTarget(target, () => ({ label }), {
    skipMaintenance: true,
  });
  assert.equal(result.label, label);
};
const inspector = new Session();
try {
  await retained.prepare(requestSource);
  await readSessionEntryInWorker(
    { ...options, storePath: seeded.path, sessionKey: "agent:synthetic:session-42" },
    undefined,
    undefined,
    (captured) => {
      target = captured;
    },
  );
  assert(target?.readSource);
  for (let i = 0; i < 50; i++) {
    await cycle();
  }
  if (values.mode === "count") {
    fs.statSync = function (...args) {
      if (String(args[0]) === seeded.path) {
        syncCalls++;
      }
      return Reflect.apply(stat, this, args);
    };
    syncBuiltinESMExports();
  }
  global.gc();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    await cycle();
  }
  const elapsedMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(thread);
  const processCpu = process.cpuUsage(cpu);
  let bytes;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node) =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    bytes = sum(profile.head) / iterations;
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      iterations,
      sessions: 5000,
      syncCalls: values.mode === "count" ? syncCalls : undefined,
      elapsedMs: values.mode === "count" ? undefined : elapsedMs / iterations,
      threadUs:
        values.mode === "count" ? undefined : (threadCpu.user + threadCpu.system) / iterations,
      processUs:
        values.mode === "count" ? undefined : (processCpu.user + processCpu.system) / iterations,
      bytes,
      load: loadavg(),
    }),
  );
} finally {
  fs.statSync = stat;
  syncBuiltinESMExports();
  await retained.release();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await flushLogger();
  fs.rmSync(root, { recursive: true, force: true });
}
