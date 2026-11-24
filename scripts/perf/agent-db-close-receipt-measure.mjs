/**
 * Real native agent open/close cycles with 10k sessions and 40 peer lease claims.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-db-close-receipt-measure.mjs
 *   --source <saved-openclaw-agent-db-lease.ts> --mode timing|allocation --iterations 2000
 *
 * --source replaces only the lease owner at load time; all other code is the checkout.
 * Run base/candidate in AB/BA order. Acceptance: unchanged native open/close counts,
 * rows, and final seal; fewer duplicate receipts and lower CPU or allocation.
 * Timing is untraced; allocation includes objects collected by minor/major GC.
 * This measures the close owner, not Gateway throughput or production close frequency.
 * Synthetic state and logs stay under .local and are removed after each run.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "src/state/openclaw-agent-db-lease.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["timing", "allocation"].includes(values.mode));
assert(globalThis.gc, "Use --expose-gc");
const source = fs.readFileSync(values.source, "utf8");
let ownerLoaded = false;
registerHooks({
  load(url, context, nextLoad) {
    if (
      url.startsWith("file:") &&
      new URL(url).pathname.endsWith("/src/state/openclaw-agent-db-lease.ts")
    ) {
      ownerLoaded = true;
      return {
        format: "module",
        source: stripTypeScriptTypes(source, { mode: "transform" }),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
fs.mkdirSync(".local", { recursive: true });
const root = fs.mkdtempSync(path.resolve(".local/agent-close-measure-"));
process.env.OPENCLAW_STATE_DIR = root;
const env = { OPENCLAW_STATE_DIR: root };
const logFile = path.join(root, "measure.log");
const inspector = new Session();
const { applyLoggingConfig, flushLogger } = await import("../../src/logging/logger.ts");
const { setConsoleSubsystemFilter } = await import("../../src/logging/console.ts");
applyLoggingConfig({ level: "info", file: logFile, consoleLevel: "silent" });
setConsoleSubsystemFilter(["__synthetic_measurement__"]);
const {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} = await import("../../src/state/openclaw-agent-db.ts");
const { claimOpenClawAgentDatabaseLease, releaseOpenClawAgentDatabaseLease } =
  await import("../../src/state/openclaw-agent-db-lease.ts");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
const { readSqliteDatabaseCleanClose } =
  await import("../../src/infra/sqlite-database-admission.ts");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts");
assert(ownerLoaded, "Source replacement must load the requested lease owner");
const options = { agentId: "synthetic", env };
const seeded = openOpenClawAgentDatabase(options);
const peerLeases = [];
try {
  runOpenClawAgentWriteTransaction((database) => {
    for (let i = 0; i < 10_000; i++) {
      writeSessionEntry(database, `agent:synthetic:subagent:session-${i}`, {
        sessionId: `session-${i}`,
        updatedAt: i + 1,
      });
    }
  }, options);
  for (let i = 0; i < 40; i++) {
    peerLeases.push(claimOpenClawAgentDatabaseLease({ ...options, path: seeded.path }));
  }
  closeOpenClawAgentDatabaseByPath(seeded.path);
  const cycle = () => {
    const opened = openOpenClawAgentDatabase(options);
    assert(opened.db.isOpen);
    closeOpenClawAgentDatabaseByPath(opened.path);
    assert(!opened.db.isOpen);
  };
  for (let i = 0; i < 20; i++) {
    cycle();
  }
  await flushLogger();
  const initialLogBytes = fs.statSync(logFile).size;
  await nextTurn();
  globalThis.gc();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.memoryUsage();
  const hostLoad = loadavg();
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    cycle();
  }
  await flushLogger();
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  let allocatedBytes;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node) =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  // Empty log flushes need not yield; let both arms settle deferred native disposal.
  await nextTurn();
  globalThis.gc();
  const retainedAfter = process.memoryUsage();
  const logs = fs.readFileSync(logFile).subarray(initialLogBytes).toString();
  const reopened = openOpenClawAgentDatabase(options);
  assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM session_nodes").get().n, 10_000);
  assert.equal(readSqliteDatabaseCleanClose(reopened.path), false);
  for (const lease of peerLeases.splice(0)) {
    releaseOpenClawAgentDatabaseLease(lease, { env }, "read-only");
  }
  closeOpenClawAgentDatabaseByPath(reopened.path);
  assert.equal(readSqliteDatabaseCleanClose(reopened.path), true);
  console.log(
    JSON.stringify({
      source: values.source,
      sha256: createHash("sha256").update(source).digest("hex"),
      mode: values.mode,
      iterations,
      nativeOpens: iterations,
      nativeCloses: iterations,
      receipts: logs
        .split("\n")
        .filter((line) => line.includes("agent database clean-close receipt:")).length,
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      rssBefore: before.rss,
      rssAfter: after.rss,
      peakRssKiB: process.resourceUsage().maxRSS,
      heapBefore: before.heapUsed,
      heapAfter: after.heapUsed,
      heapAfterGc: retainedAfter.heapUsed,
      rssAfterGc: retainedAfter.rss,
      hostLoad,
      rows: 10_000,
      finalSeal: true,
    }),
  );
} finally {
  for (const lease of peerLeases) {
    releaseOpenClawAgentDatabaseLease(lease, { env }, "read-only");
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await flushLogger();
  fs.rmSync(root, { recursive: true, force: true });
}
