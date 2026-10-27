/**
 * Warm reconnect binding lookup through the production profile owner, with 65 synthetic users.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/connect-profile-binding-measure.ts
 *   [--source <saved user-profile-reads.ts>] [--iterations 3000] [--users 65] [--allocation]
 *
 * The saved owner loads at its original module URL. Alternate base/candidate timing runs;
 * sample allocations separately. Setup and warmup are excluded. Acceptance: identical
 * account/email bindings, fewer worker reads and lower CPU/allocation, with no material
 * latency regression. CPU reports main-thread and whole-process cost; sampled allocations
 * cover the main isolate only. This is owner proof, not connect-to-hello or Gateway load proof.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    iterations: { type: "string", default: "3000" },
    users: { type: "string", default: "65" },
    allocation: { type: "boolean", default: false },
  },
});
assert(globalThis.gc, "Run with --expose-gc");
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const iterations = integer(values.iterations, "--iterations");
const userCount = integer(values.users, "--users");
const owner = new URL("../../src/state/user-profile-reads.ts", import.meta.url);
const source = readFileSync(values.source ?? owner, "utf8");
let replaced = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== owner.href) {
      return nextLoad(url, context);
    }
    replaced = true;
    return { format: "module-typescript", source, shortCircuit: true };
  },
});
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(path.resolve(".local/connect-profile-binding-"));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, '{"plugins":{"enabled":false}}');
const options = { path: path.join(root, "openclaw.sqlite") };
const { resolveCanonicalCachedGitHubIdentity: resolveIdentity } =
  await import("../../src/state/user-profile-reads.ts");
hooks.deregister();
assert(replaced, "Requested profile owner was not loaded");
const { syncGitHubIdentity } = await import("../../src/state/user-profile-writes.worker.js");
const { prepareUserProfileCatalog } = await import("../../src/state/user-profile-list.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const { setDiagnosticsEnabledForProcess } = await import("../../src/infra/diagnostic-events.js");
const { onWorkerRequestMetrics } = await import("../../src/infra/worker-request-diagnostics.js");
const inspector = new Session();
let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
let stopMetrics: (() => void) | undefined;
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + sampledBytes(child), 0);
}
try {
  const users = Array.from({ length: userCount }, (_, index) => {
    const accountId = index + 1;
    const email = `synthetic-${index}@example.test`;
    const profile = syncGitHubIdentity(
      {
        identity: { accountId, login: `synthetic-${index}` },
        authenticationAlias: { kind: "email", email },
      },
      options,
    );
    return { binding: { accountId, email }, profileId: profile.id, updatedAt: profile.updatedAt };
  });
  catalog = await prepareUserProfileCatalog(options);
  async function lookup(index: number) {
    const user = users[index % users.length]!;
    const result = await resolveIdentity(user.binding, options);
    assert.equal(result?.profileId, user.profileId);
    assert.equal(result?.updatedAt, user.updatedAt);
  }
  for (let index = 0; index < userCount * 2; index++) {
    await lookup(index);
  }
  const latencies = new Float64Array(iterations);
  const workerRequests: Record<string, number> = {};
  setDiagnosticsEnabledForProcess(true);
  stopMetrics = onWorkerRequestMetrics((kind, requestClass, phase) => {
    if (phase === "completed") {
      const key = `${kind}:${requestClass}`;
      workerRequests[key] = (workerRequests[key] ?? 0) + 1;
    }
  });
  globalThis.gc();
  const memoryBefore = process.memoryUsage();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const processCpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    await lookup(index);
    latencies[index] = performance.now() - before;
  }
  const wallMs = performance.now() - started;
  const usedThread = process.threadCpuUsage(threadCpu);
  const usedProcess = process.cpuUsage(processCpu);
  stopMetrics();
  stopMetrics = undefined;
  const allocatedBytes = values.allocation
    ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  latencies.sort();
  const percentile = (p: number) => latencies[Math.ceil((p / 100) * iterations) - 1];
  console.log(
    JSON.stringify({
      sourceHash: hash("sha256", source),
      mode: values.allocation ? "allocation" : "timing",
      users: userCount,
      iterations,
      wallMs,
      p50Ms: percentile(50),
      p95Ms: percentile(95),
      p99Ms: percentile(99),
      mainThreadCpuMs: (usedThread.user + usedThread.system) / 1000,
      processCpuMs: (usedProcess.user + usedProcess.system) / 1000,
      allocatedBytes,
      allocatedBytesPerLookup:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      workerRequests,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    }),
  );
} finally {
  stopMetrics?.();
  inspector.disconnect();
  catalog?.release();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
  rmSync(root, { recursive: true, force: true });
}
