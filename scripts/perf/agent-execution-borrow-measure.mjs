// Agent execution borrowing with real worker commands and synthetic session rows.
// --phase cold --capture sync|async measures capture and two assertions without a native handle.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-execution-borrow-measure.mjs
//   --root <new-synthetic-directory> --source <saved-execution-owner.ts> --mode count|timing|allocation
// Count separately; timing/allocation use original filesystem builtins. Run A1/B/A2 five times.
// Verify one fewer main-thread stat per canonical borrow and unchanged worker results;
// report CPU/allocation costs alongside the retained A/A controls. This is owner proof,
// not a whole-Gateway throughput measurement; filesystem size does not affect warm capture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    source: { type: "string", default: "src/state/openclaw-agent-execution-owner.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "1000" },
    capture: { type: "string", default: "sync" },
    phase: { type: "string", default: "warm" },
  },
});
assert(values.root && global.gc, "Use --root and --expose-gc");
assert(["count", "timing", "allocation"].includes(values.mode));
assert(["sync", "async"].includes(values.capture));
assert(["warm", "cold"].includes(values.phase));
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = path.resolve(values.root);
fs.mkdirSync(root);
process.env.OPENCLAW_STATE_DIR = root;
const source = fs.readFileSync(values.source, "utf8");
let loaded = false;
registerHooks({
  load(url, context, nextLoad) {
    if (
      url.startsWith("file:") &&
      new URL(url).pathname.endsWith("/src/state/openclaw-agent-execution-owner.ts")
    ) {
      loaded = true;
      return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { applyLoggingConfig, flushLogger } = await import("../../src/logging/logger.ts");
applyLoggingConfig({
  level: "error",
  file: path.join(root, "measure.log"),
  consoleLevel: "silent",
});
const {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} = await import("../../src/state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts");
const { captureOpenClawAgentDatabaseExecution, captureOpenClawAgentDatabaseExecutionAsync } =
  await import("../../src/state/openclaw-agent-execution.ts");
const capture =
  values.capture === "async"
    ? captureOpenClawAgentDatabaseExecutionAsync
    : captureOpenClawAgentDatabaseExecution;
const { createSqliteWorkerOperationAdmission } =
  await import("../../src/infra/sqlite-worker-operation-admission.ts");
assert(loaded, "Requested execution owner was not loaded");
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
const retained = values.phase === "warm" ? await capture(options) : undefined;
let syncCalls = 0;
let syncRealpaths = 0;
const stat = fs.statSync;
const realpath = fs.realpathSync.native;
const cycle = async () => {
  const borrowed = await capture(options);
  try {
    if (values.phase === "cold") {
      borrowed.assertCurrent();
      borrowed.assertCurrent();
      return;
    }
    const result = await borrowed.runExisting(requestSource, (scope) =>
      scope.execute({
        type: "session.entry.read",
        input: { sessionKeys: ["agent:synthetic:session-42"] },
      }),
    );
    assert.equal(result.entries[0].entry.sessionId, "synthetic-42");
  } finally {
    await borrowed.release();
  }
};
const inspector = new Session();
try {
  await retained?.prepare(requestSource);
  for (let i = 0; i < 50; i++) {
    await cycle();
  }
  if (values.mode === "count") {
    fs.statSync = function (...args) {
      if (args[0] === seeded.path) {
        syncCalls++;
      }
      return Reflect.apply(stat, this, args);
    };
    fs.realpathSync.native = function (...args) {
      if (args[0] === seeded.path) {
        syncRealpaths++;
      }
      return Reflect.apply(realpath, this, args);
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
      capture: values.capture,
      phase: values.phase,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      iterations,
      sessions: 5000,
      syncCalls: values.mode === "count" ? syncCalls : undefined,
      syncRealpaths: values.mode === "count" ? syncRealpaths : undefined,
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
  fs.realpathSync.native = realpath;
  syncBuiltinESMExports();
  await retained?.release();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await flushLogger();
  fs.rmSync(root, { recursive: true, force: true });
}
