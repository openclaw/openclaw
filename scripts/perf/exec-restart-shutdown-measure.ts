/**
 * Real request-owned exec cancellation, finalizer write, and native database seal.
 * node --import ./scripts/tsx.mjs scripts/perf/exec-restart-shutdown-measure.ts \
 *   --state-dir /absolute/new-fixture [--source /saved/exec-request-context.ts]
 *
 * Run at least five interleaved baseline/candidate pairs and identical A/A pairs.
 * Accept earlier SIGTERM and lower median/p95 shutdown with every finalizer write
 * and written receipt intact. --allocation samples separately from timing;
 * --control uses a direct Stop (unchanged cancellation) for an A/A control.
 * --drain-ms models other already-accepted work after restart cancellation.
 * The command ignores SIGTERM and exercises the existing 5s child escalation.
 * No Gateway is killed. This is owner proof, not a whole Gateway or 35GiB proof:
 * the fixture deliberately retains a native database borrow for its real exec
 * finalizer; it does not assert that production commands directly own DB leases.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    source: { type: "string" },
    "drain-ms": { type: "string", default: "2200" },
    "native-owner": { type: "string" },
    control: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "Pass a new isolated --state-dir");
assert(process.platform !== "win32" && !process.versions.bun, "Requires POSIX Node");
const drainMs = Number(values["drain-ms"]);
assert(Number.isFinite(drainMs) && drainMs >= 0 && drainMs <= 5000);
const root = path.resolve(values["state-dir"]);
await mkdir(root);
const home = path.join(root, "home");
await mkdir(home);
process.env.OPENCLAW_HOME = home;
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_EXEC_SHELL_SNAPSHOT = "0";
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownerUrl = new URL("../../src/infra/exec-request-context.ts", import.meta.url).href;
let sourceLoaded = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === ownerUrl && values.source) {
      sourceLoaded = true;
      return {
        format: "module-typescript",
        source: readFileSync(values.source, "utf8"),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
// Keep the native anchor free of source-loader compiler children.
const nativeDirectory = path.join(root, "native");
await mkdir(nativeDirectory);
const nativeEntry = path.join(nativeDirectory, "service-child-group-anchor.mjs");
if (values["native-owner"]) {
  await writeFile(
    nativeEntry,
    `await import(${JSON.stringify(pathToFileURL(path.resolve(values["native-owner"])).href)});\n`,
  );
} else {
  const { build } = await import("esbuild");
  await symlink(path.join(sourceRoot, "node_modules"), path.join(nativeDirectory, "node_modules"));
  await build({
    absWorkingDir: sourceRoot,
    entryPoints: ["src/process/supervisor/service-child-group-anchor.ts"],
    outfile: nativeEntry,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    define: { WORKER_DEPLOY_BUILD: "false" },
    logLevel: "warning",
  });
}
const { registerSealedRuntimeProcessEntrypoints } =
  await import("../../src/infra/runtime-process-url.js");
registerSealedRuntimeProcessEntrypoints(
  "serviceChildRelay",
  pathToFileURL(path.join(nativeDirectory, "fixture.mjs")).href,
);
const { applyLoggingConfig, flushLogger } = await import("../../src/logging/logger.js");
const { setConsoleSubsystemFilter } = await import("../../src/logging/console.js");
const logFile = path.join(root, "measure.log");
applyLoggingConfig({ level: "info", file: logFile, consoleLevel: "silent" });
setConsoleSubsystemFilter(["__synthetic_measurement__"]);
const { captureExecRequestOwners, withExecRequestTurn } =
  await import("../../src/infra/exec-request-context.js");
const { createAgentRunDirectAbortError, createAgentRunRestartAbortError } =
  await import("../../src/agents/run-termination.js");
const { runExecProcess } = await import("../../src/agents/bash-tools.exec-runtime.js");
const { shutdownProcessSupervisor } = await import("../../src/process/supervisor/index.js");
const {
  borrowOpenClawAgentDatabase,
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { readSqliteDatabaseCleanClose } =
  await import("../../src/infra/sqlite-database-admission.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
assert(!values.source || sourceLoaded, "Requested baseline owner was not loaded");
const options = { agentId: "synthetic", env: process.env };
const database = openOpenClawAgentDatabase(options);
const borrowed = borrowOpenClawAgentDatabase(options);
const childFile = path.join(root, "command.cjs");
const readyFile = path.join(root, "ready");
const termFile = path.join(root, "term");
const controller = new AbortController();
const interrupted = Promise.withResolvers<void>();
const inspector = new Session();
let request: Promise<void> | undefined;
let execution: Awaited<ReturnType<typeof runExecProcess>> | undefined;
try {
  await writeFile(
    childFile,
    `const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termFile)}, String(Date.now())));
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
process.stdout.write('durable-command-output\\n');
`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const started = Promise.withResolvers<Awaited<ReturnType<typeof runExecProcess>>>();
  const identity = {
    runId: "shutdown-measure",
    sessionId: "shutdown-measure",
    agentId: "synthetic",
  };
  let start = 0;
  let finalizerMs = 0;
  let requestMs = 0;
  request = withExecRequestTurn({ identity, abortSignal: controller.signal }, async () => {
    execution = await runExecProcess({
      command: `exec ${quote(process.execPath)} ${quote(childFile)}`,
      workdir: root,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      timeoutSec: null,
      requestOwners: captureExecRequestOwners(identity),
      onSettledBeforeNotify(outcome) {
        assert(borrowed.db.isOpen, "Accepted finalizer lost its native database");
        assert(outcome.aggregated.includes("durable-command-output"));
        runOpenClawAgentWriteTransaction((opened) => {
          writeSessionEntry(opened, "agent:synthetic:finalizer", {
            sessionId: "finalizer-write",
            updatedAt: Date.now(),
          });
        }, options);
        finalizerMs = performance.now() - start;
        borrowed.release();
      },
    });
    started.resolve(execution);
    await interrupted.promise;
    // Independent accepted request work; it does not control child exit.
    await delay(drainMs);
  }).then(() => {
    requestMs = performance.now() - start;
  });
  void request.catch(started.reject);
  const active = await started.promise;
  const readinessDeadline = performance.now() + 15_000;
  while (!(await readFile(readyFile, "utf8").catch(() => ""))) {
    assert(performance.now() < readinessDeadline, "Command readiness timed out");
    await delay(20);
  }
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const wallStart = Date.now();
  start = performance.now();
  process.once("SIGTERM", () => {
    controller.abort(
      values.control ? createAgentRunDirectAbortError() : createAgentRunRestartAbortError(),
    );
    interrupted.resolve();
  });
  process.kill(process.pid, "SIGTERM");
  await request;
  const supervisorStartMs = performance.now() - start;
  await shutdownProcessSupervisor();
  const supervisorEndMs = performance.now() - start;
  await active.promise;
  assert.equal(database.db.prepare("SELECT count(*) AS n FROM session_nodes").get()?.n, 1);
  await closeOpenClawAgentDatabasesAsync();
  const sealMs = performance.now() - start;
  assert.equal(readSqliteDatabaseCleanClose(database.path), true);
  const used = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  let allocatedBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
  }
  await flushLogger();
  const receipts = (await readFile(logFile, "utf8"))
    .split("\n")
    .filter((line) => line.includes("agent database clean-close receipt:"));
  assert(
    receipts.some((line) => line.includes("receipt: written")),
    "Missing written receipt",
  );
  console.log(
    JSON.stringify({
      source: values.source ?? ownerUrl,
      control: values.control,
      runtime: process.version,
      platform: process.platform,
      hostLoad: os.loadavg(),
      drainMs,
      termMs: Number(await readFile(termFile, "utf8")) - wallStart,
      requestMs,
      supervisorStartMs,
      supervisorEndMs,
      supervisorWaitMs: supervisorEndMs - supervisorStartMs,
      finalizerMs,
      sealMs,
      cpuMs: (used.user + used.system) / 1000,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      rssDeltaBytes: after.rss - before.rss,
      ...(values.allocation ? { allocatedBytes, samplingInterval: 32768 } : {}),
      finalizerWrites: 1,
      writtenReceipt: true,
      sealed: true,
    }),
  );
} finally {
  controller.abort(createAgentRunDirectAbortError());
  interrupted.resolve();
  // Failed setup must still join physical cleanup and accepted finalizer writes.
  await Promise.allSettled([shutdownProcessSupervisor(), request]);
  await Promise.allSettled([execution?.promise]);
  borrowed.release();
  try {
    await closeOpenClawAgentDatabasesAsync();
  } finally {
    try {
      await closeOpenClawStateDatabaseAsync();
    } finally {
      inspector.disconnect();
      hooks.deregister();
    }
  }
}
