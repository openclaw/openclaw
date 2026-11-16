// Node 26: --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-validation-capture-measure.mjs
// --root <new-synthetic-directory> --source <validation-owner.ts> --iterations 1000
// JSON-line commands select {"kind":"admission"|"retained"|"missing"|"unadmitted", "count":true|false}.
// Use independent A1/B/A2 processes, five rounds each; {"stop":true} releases the fixture.
// Counts are separate from uninstrumented CPU/allocation samples. This is owner proof,
// not a Gateway throughput claim; all processes seed the same 5,000 synthetic sessions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    source: { type: "string", default: "src/state/openclaw-agent-db-validation-cache.ts" },
    iterations: { type: "string", default: "1000" },
  },
});
assert(values.root && global.gc, "Use --root and --expose-gc");
assert(
  Number.isFinite(getHeapStatistics().total_allocated_bytes),
  "Use Node 26 allocation counters",
);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = path.resolve(values.root);
fs.mkdirSync(root);
process.env.OPENCLAW_STATE_DIR = root;
const source = fs.readFileSync(values.source, "utf8");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
let loaded = false;
registerHooks({
  load(url, context, nextLoad) {
    if (
      url.startsWith("file:") &&
      new URL(url).pathname.endsWith("/openclaw-agent-db-validation-cache.ts")
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
const {
  captureOpenClawAgentDatabaseReadValidation: capture,
  releaseOpenClawAgentDatabaseReadValidation: releaseValidation,
} = await import("../../src/state/openclaw-agent-db-validation-cache.ts");
assert(loaded, "Requested validation owner was not loaded");
const options = { agentId: "synthetic", env: { OPENCLAW_STATE_DIR: root } };
const database = openOpenClawAgentDatabase(options);
runOpenClawAgentWriteTransaction((owner) => {
  for (let i = 0; i < 5000; i++) {
    writeSessionEntry(owner, `agent:synthetic:session-${i}`, {
      sessionId: `synthetic-${i}`,
      updatedAt: i + 1,
    });
  }
}, options);
const missing = { agentId: database.agentId, path: `${database.path}.missing` };
const stat = fs.statSync;
const realpath = fs.realpathSync.native;
async function cycle(kind) {
  const receipt = await capture(
    kind === "missing" ? missing : database,
    kind === "admission" ? "admission" : "retained",
  );
  if (kind === "missing" || kind === "unadmitted") {
    assert.equal(receipt, undefined);
  } else {
    assert(receipt && receipt.validation.agentId === database.agentId);
    receipt.assertCurrent();
  }
}
async function measure({ kind, count = false }) {
  assert(["admission", "retained", "missing", "unadmitted"].includes(kind));
  if (kind === "unadmitted") {
    releaseValidation([{ path: database.path }]);
  }
  for (let i = 0; i < 100; i++) {
    await cycle(kind);
  }
  let stats = 0;
  let realpaths = 0;
  if (count) {
    fs.statSync = function (...args) {
      stats++;
      return Reflect.apply(stat, this, args);
    };
    fs.realpathSync.native = function (...args) {
      realpaths++;
      return Reflect.apply(realpath, this, args);
    };
    syncBuiltinESMExports();
  }
  global.gc();
  const allocated = getHeapStatistics().total_allocated_bytes;
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const started = performance.now();
  try {
    for (let i = 0; i < iterations; i++) {
      await cycle(kind);
    }
    const elapsedMs = performance.now() - started;
    const threadCpu = process.threadCpuUsage(thread);
    const processCpu = process.cpuUsage(cpu);
    return {
      kind,
      count,
      iterations,
      sessions: 5000,
      sourceSha256,
      stats: count ? stats : undefined,
      realpaths: count ? realpaths : undefined,
      elapsedMs: elapsedMs / iterations,
      threadUs: (threadCpu.user + threadCpu.system) / iterations,
      processUs: (processCpu.user + processCpu.system) / iterations,
      bytes: (getHeapStatistics().total_allocated_bytes - allocated) / iterations,
      load: loadavg(),
    };
  } finally {
    fs.statSync = stat;
    fs.realpathSync.native = realpath;
    syncBuiltinESMExports();
  }
}
try {
  await cycle("retained");
  console.log(JSON.stringify({ ready: true }));
  const commands = createInterface({ input: process.stdin });
  for await (const line of commands) {
    const command = JSON.parse(line);
    if (command.stop) {
      break;
    }
    console.log(JSON.stringify(await measure(command)));
  }
  commands.close();
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await flushLogger();
  fs.rmSync(root, { recursive: true, force: true });
}
