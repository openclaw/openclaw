/**
 * Measure the real cron continuation owner after one acknowledged SQLite write.
 * Synthetic fixture: 64 allowed tools, account policy, CLI binding, and 2 KiB prompt.
 * Repeated unchanged syncs must not enter the persistence guard. This is an owner
 * workload, not Gateway throughput or a claim about the frequency of cron turns.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-continuation-snapshot-measure.ts \
 *   --mode timing --operations 5000 --output .local/cron-continuation/base.json
 * --owner accepts a baseline module with relative imports resolving in this checkout.
 * Run counterbalanced base/candidate arms. Use separate allocation and counts modes:
 * allocation includes collected objects; counts wraps structuredClone outside timing.
 * Each invocation creates and removes its own synthetic state beside --output.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { MutableCronSession } from "../../src/cron/isolated-agent/run-session-state.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    owner: { type: "string" },
    output: { type: "string" },
    operations: { type: "string", default: "5000" },
  },
});
assert(["timing", "allocation", "counts"].includes(values.mode));
assert(values.output, "--output is required");
assert(global.gc, "Run with --expose-gc");
assert(!process.execArgv.some((arg) => arg.startsWith("--trace-gc")), "Use untraced runs");
const operations = parseStrictIntegerOption({
  raw: values.operations,
  label: "--operations",
  min: 1,
  fallback: 5000,
});
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const stateDir = await mkdtemp(path.join(path.dirname(output), "synthetic-state-"));
const configPath = path.join(stateDir, "openclaw.json");
await mkdir(path.join(stateDir, "home"));
await mkdir(path.join(stateDir, "tmp"));
await writeFile(
  configPath,
  JSON.stringify({ agents: { entries: { main: {} } }, plugins: { enabled: false } }),
);
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../src/cron/isolated-agent/run-session-state.ts", import.meta.url);
const ownerSha256 = createHash("sha256")
  .update(await readFile(ownerUrl))
  .digest("hex");
const owner: typeof import("../../src/cron/isolated-agent/run-session-state.js") = await import(
  ownerUrl.href
);
const { loadSessionEntry } = await import("../../src/config/sessions/session-accessor.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
const runSessionKey = "agent:main:cron:synthetic:run:synthetic-run";
const cronSession: MutableCronSession = {
  storePath,
  store: {},
  sessionEntry: {
    sessionId: "synthetic-run",
    lifecycleRevision: "synthetic-revision",
    updatedAt: 1_800_000_000_000,
    modelProvider: "mock",
    model: "synthetic",
    cliSessionBindings: { mock: { sessionId: "synthetic-provider-session", forceReuse: true } },
  },
  lifecycleRevision: "synthetic-revision",
  systemSent: true,
  isNewSession: true,
  previousSessionId: undefined,
  resetBoundaryPending: undefined,
  initialSessionEntry: undefined,
};
const continuation = owner.createCronRunContinuationSession({
  cronSession,
  runSessionKey,
  toolsAllow: Array.from({ length: 64 }, (_, index) => `synthetic_tool_${index}`),
  scheduledToolPolicy: {
    version: 1,
    mode: "account",
    ownerSessionKey: "agent:main:synthetic-owner",
    ownerAccountId: "synthetic-account",
  },
  scheduledToolCallerOrigin: { kind: "local" },
  toolsAllowExecTarget: { version: 1, host: "gateway", ask: "always" },
  toolsAllowExecTargetRequirement: {
    version: 1,
    target: { version: 1, host: "gateway", ask: "always" },
    grantIndex: 1,
  },
  cliSessionBindingFacts: {
    extraSystemPromptStatic: "Synthetic continuation prompt. ".repeat(70),
    sourceReplyDeliveryMode: "automatic",
    requireExplicitMessageTarget: true,
  },
});
const originalClone = globalThis.structuredClone;
let cloneCalls = 0;
let continuationCloneCalls = 0;
let attemptedWrites = 0;
const rejectUnexpectedWrite = () => {
  attemptedWrites++;
  throw new Error("Unchanged continuation unexpectedly entered persistence");
};
const inspector = new Session();
try {
  await continuation.initialize();
  const storedBefore = loadSessionEntry({ storePath, sessionKey: runSessionKey });
  assert(storedBefore?.cronRunContinuation);
  assert.equal(storedBefore.cronRunContinuation.phase, "running");
  assert.equal(storedBefore.cronRunContinuation.toolsAllow?.length, 64);
  for (let index = 0; index < 100; index++) {
    await continuation.sync(rejectUnexpectedWrite);
  }
  global.gc();
  await nextTurn();
  await nextTurn();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (values.mode === "counts") {
    globalThis.structuredClone = (value, options) => {
      cloneCalls++;
      if (value && typeof value === "object" && "phase" in value && "lifecycleRevision" in value) {
        continuationCloneCalls++;
      }
      return originalClone(value, options);
    };
  }
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage?.();
  const measuredStart = performance.now();
  for (let index = 0; index < operations; index++) {
    await continuation.sync(rejectUnexpectedWrite);
  }
  const measuredEnd = performance.now();
  const cpuUsed = process.cpuUsage(cpu);
  const threadUsed = thread && process.threadCpuUsage(thread);
  const memoryAfter = process.memoryUsage();
  globalThis.structuredClone = originalClone;
  const profile =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  await nextTurn();
  await nextTurn();
  assert.equal(attemptedWrites, 0);
  assert.deepEqual(loadSessionEntry({ storePath, sessionKey: runSessionKey }), storedBefore);
  const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
  const report = {
    scope: "Real cron continuation owner; unchanged syncs after acknowledged SQLite initialization",
    mode: values.mode,
    node: process.version,
    owner: ownerUrl.href,
    ownerSha256,
    operations,
    tools: 64,
    warmup: 100,
    attemptedWrites,
    hostLoad,
    wallUsPerOperation: ((measuredEnd - measuredStart) * 1000) / operations,
    processCpuUsPerOperation: (cpuUsed.user + cpuUsed.system) / operations,
    threadCpuUsPerOperation: threadUsed ? (threadUsed.user + threadUsed.system) / operations : null,
    memory: { before: memoryBefore, after: memoryAfter },
    allocation: profile
      ? {
          sampledBytes: sampledBytes(profile.head),
          bytesPerOperation: sampledBytes(profile.head) / operations,
        }
      : null,
    counts: values.mode === "counts" ? { cloneCalls, continuationCloneCalls } : null,
  };
  if (profile) {
    await writeFile(`${output}.heapprofile`, JSON.stringify(profile));
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  globalThis.structuredClone = originalClone;
  if (values.mode === "allocation") {
    inspector.disconnect();
  }
  await closeOpenClawAgentDatabasesAsync(stateDir);
  await closeOpenClawStateDatabaseAsync();
  await rm(stateDir, { recursive: true, force: true });
}
