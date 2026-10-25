// Offline, fresh team-shape fixture only; the cache must be cold. Example:
// node --import ./scripts/tsx.mjs scripts/perf/session-cost-refresh-measure.ts \
//   --state-dir .local/cold-fixture --output .local/refresh-result.json
// Reuse identical built worker artifacts for both source-owner revisions. This
// profiles the actual queued refresh, not Gateway traffic or worker allocations.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    "timeout-ms": { type: "string", default: "900000" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const root = realpathSync(values["state-dir"]);
const output = path.resolve(values.output);
const timeoutMs = Number(values["timeout-ms"]);
assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "--timeout-ms must be positive");
const fixture: unknown = JSON.parse(
  readFileSync(path.join(root, "team-shape-summary.json"), "utf8"),
);
assert(
  isRecord(fixture) &&
    fixture.format === "openclaw-team-shape-v1" &&
    typeof fixture.sessionCount === "number" &&
    fixture.sessionCount > 50 &&
    typeof fixture.now === "number" &&
    Number.isFinite(fixture.now),
);
const { sessionCount, now } = fixture;
const configPath = path.join(root, "openclaw.json");
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
};
const source = new URL("../../src/infra/session-cost-usage-cache-runtime.ts", import.meta.url);
const sourceSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
const [owner, { AsyncWorkScope }, agentDb, stateDb, { loadConfig }] = await Promise.all([
  import("../../src/infra/session-cost-usage-cache-runtime.js"),
  import("../../src/shared/async-work-scope.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/config/config.js"),
]);
const config = loadConfig();
const scope = new AsyncWorkScope();
const timeout = new Error("Usage refresh benchmark timed out");
const deadline = setTimeout(() => scope.beginClose(timeout), timeoutMs);
const hardDeadline = setTimeout(() => process.exit(124), timeoutMs + 30_000);
const inspector = new Session();
const samplingInterval = 1024;
const read = () =>
  scope.run(() =>
    owner.loadCostUsageSummaryFromCache({
      config,
      agentId: "main",
      startMs: now - 31 * 86_400_000,
      endMs: now + 86_400_000,
      requestRefresh: false,
    }),
  );
try {
  const before = await read();
  assert(before.cacheStatus?.cachedFiles === 0, "Use a fresh fixture with no usage rollups");
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  scope.run(() =>
    owner.requestCostUsageCacheRefresh({
      config,
      agentId: "main",
      storePath: agentDb.resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    }),
  );
  await scope.runWhenIdle(() => undefined);
  scope.signal.throwIfAborted();
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const after = await read();
  assert(after.cacheStatus?.status === "fresh", "Refresh did not complete successfully");
  assert.equal(after.cacheStatus.cachedFiles, sessionCount);
  assert(Number.isFinite(after.totals.totalTokens) && after.totals.totalTokens >= 0);
  assert(Number.isFinite(after.totals.totalCost) && after.totals.totalCost >= 0);
  let sampledBytes = 0;
  let onRemainingBytes = 0;
  function visit(node: HeapProfiler.SamplingHeapProfileNode, remaining = false, parentName = "") {
    // tsx leaves this callback anonymous; its sole aggregation caller identifies it.
    const inRemaining =
      remaining ||
      node.callFrame.functionName === "onRemaining" ||
      (parentName === "refreshCostUsageCacheForAgent" && node.callFrame.url === source.href);
    sampledBytes += node.selfSize;
    if (inRemaining) {
      onRemainingBytes += node.selfSize;
    }
    node.children.forEach((child) => visit(child, inRemaining, node.callFrame.functionName));
  }
  visit(profile.head);
  assert(onRemainingBytes > 0, "Profile did not capture the deferred-session callback");
  const result = {
    sourceSha256,
    node: process.version,
    sessions: sessionCount,
    wallMs,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    samplingInterval,
    sampledBytes,
    onRemainingBytes,
    cacheStatus: after.cacheStatus,
    totals: after.totals,
  };
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(`${output}.heapprofile`, JSON.stringify(profile));
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector.disconnect();
  try {
    await scope.drain();
    try {
      await agentDb.closeOpenClawAgentDatabasesAsync();
    } finally {
      await stateDb.closeOpenClawStateDatabaseAsync();
    }
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardDeadline);
  }
}
