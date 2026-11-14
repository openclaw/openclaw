// Warm agent execution borrowing with real worker commands and synthetic session rows.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-execution-borrow-measure.mjs
//   --root <new-synthetic-directory> --source <saved-execution-owner.ts> --mode timing|allocation
// Run A1/B/A2, five times each. Acceptance: one fewer main-thread stat per borrow,
// unchanged worker command results and no CPU/allocation regression. This is owner proof,
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
  },
});
assert(values.root && global.gc, "Use --root and --expose-gc");
assert(["timing", "allocation"].includes(values.mode));
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
const { captureOpenClawAgentDatabaseExecution: capture } =
  await import("../../src/state/openclaw-agent-execution.ts");
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
const retained = capture(options);
let active = false;
let syncCalls = 0;
const stat = fs.statSync;
fs.statSync = function (...args) {
  if (active && String(args[0]) === seeded.path) {
    syncCalls++;
  }
  return Reflect.apply(stat, this, args);
};
syncBuiltinESMExports();
const cycle = async () => {
  const borrowed = capture(options);
  try {
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
  await retained.prepare(requestSource);
  for (let i = 0; i < 50; i++) {
    await cycle();
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
  active = true;
  for (let i = 0; i < iterations; i++) {
    await cycle();
  }
  active = false;
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
      syncCalls,
      elapsedMs: elapsedMs / iterations,
      threadUs: (threadCpu.user + threadCpu.system) / iterations,
      processUs: (processCpu.user + processCpu.system) / iterations,
      bytes,
      load: loadavg(),
    }),
  );
} finally {
  active = false;
  fs.statSync = stat;
  syncBuiltinESMExports();
  await retained.release();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await flushLogger();
  fs.rmSync(root, { recursive: true, force: true });
}
