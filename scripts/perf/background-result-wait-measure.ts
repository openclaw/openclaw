// Synthetic controller + real transcript storage; no Gateway or provider traffic.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeGatewayGcTraceMarker, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "gc-log": { type: "string" },
    samples: { type: "string", default: "6" },
    "hold-ms": { type: "string", default: "2000" },
    "start-at": { type: "string", default: "0" },
  },
});
assert(values["state-dir"], "Pass a new isolated --state-dir");
const root = path.resolve(values["state-dir"]);
await mkdir(root);
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({ plugins: { enabled: false } }));
const samples = parseStrictIntegerOption({
  raw: values.samples,
  label: "samples",
  min: 1,
  fallback: 6,
});
const holdMs = parseStrictIntegerOption({
  raw: values["hold-ms"],
  label: "hold-ms",
  min: 1500,
  fallback: 2000,
});
const startAt = parseStrictIntegerOption({
  raw: values["start-at"],
  label: "start-at",
  min: 0,
  fallback: 0,
});
assert(global.gc && values["gc-log"], "Run with --expose-gc --trace-gc-nvp and --gc-log");
const profilePath = path.join(root, "gc-window");
writeGatewayGcTraceMarker("identify-start", profilePath);
global.gc();
writeGatewayGcTraceMarker("identify-stop", profilePath);
const [storage, lifecycle, admission, background, diagnostics, logging, database, work, deferred] =
  await Promise.all([
    import("../../src/config/sessions/session-accessor.js"),
    import("../../src/sessions/session-controller.lifecycle.js"),
    import("../../src/sessions/session-controller.admission.js"),
    import("../../src/sessions/background-session-result.js"),
    import("../../src/infra/diagnostic-events.js"),
    import("../../src/logging/logger.js"),
    import("../../src/state/openclaw-agent-db.js"),
    import("../../src/infra/gateway-active-work.js"),
    import("../../src/shared/deferred.js"),
  ]);
const logPath = path.join(root, "lifecycle.log");
logging.applyLoggingConfig({ level: "warn", consoleLevel: "silent", file: logPath });
const scope = {
  agentId: "main",
  sessionKey: "agent:main:webchat:synthetic-background",
  sessionId: "synthetic-session",
  storePath: path.join(root, "agents/main/sessions/sessions.json"),
};
await storage.replaceSessionEntry(scope, {
  sessionId: scope.sessionId,
  lifecycleRevision: "synthetic-revision",
  updatedAt: 1,
});
const config = { session: { store: scope.storePath } };
const result = (
  key: string,
  onMessageCommitted?: Parameters<
    typeof background.commitBackgroundResultToSession
  >[0]["onMessageCommitted"],
) =>
  background.commitBackgroundResultToSession({
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    expectedGeneration: { sessionId: scope.sessionId, lifecycleRevision: "synthetic-revision" },
    text: `Synthetic result ${key}`,
    idempotencyKey: key,
    provenance: { kind: "cron", jobId: "synthetic-job", runId: key },
    config,
    onMessageCommitted,
  });
diagnostics.setDiagnosticsEnabledForProcess(false);
assert((await result("warmup")).ok);
await logging.flushLogger();
if (startAt) {
  assert(Date.now() < startAt, "Preparation missed shared start time");
  await delay(startAt - Date.now());
}
global.gc();
await delay(0);
diagnostics.setDiagnosticsEnabledForProcess(true);
writeGatewayGcTraceMarker("diagnostics-start", profilePath);
const loop = monitorEventLoopDelay({ resolution: 1 });
const gc: Array<{ durationMs: number; kind: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push({ durationMs: entry.duration, kind: Reflect.get(entry, "detail").kind });
  }
});
observer.observe({ entryTypes: ["gc"] });
loop.enable();
const cpuStart = process.cpuUsage();
const measurements: Array<{
  commitMs: number;
  resultCustodyAfterCommit: number;
  turnStillRunning: boolean;
}> = [];
try {
  for (let i = 0; i < samples; i++) {
    const entered = deferred.createDeferredCore();
    const release = deferred.createDeferredCore();
    let running = true;
    const turn = admission.withSessionTurn(scope, async () => {
      const effect = await lifecycle.beginSessionEffect({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
        assertAllowed: () => {},
      });
      try {
        entered.resolve();
        await release.promise;
      } finally {
        effect.release();
        running = false;
      }
    });
    await entered.promise;
    const began = performance.now();
    const finish = delay(holdMs).then(() => release.resolve());
    let commitMs = 0;
    try {
      assert(
        (
          await result(`sample-${i}`, (_message, acceptCompletion) => {
            commitMs = performance.now() - began;
            // Make both sides emit the existing slow-operation diagnostic, even
            // when queue wait is zero. Excluded from commit latency above.
            acceptCompletion(() => delay(1100));
          })
        ).ok,
      );
      measurements.push({
        commitMs,
        resultCustodyAfterCommit: work.readGatewayMaintenanceWork().counts.sessionMutations,
        turnStillRunning: running,
      });
      assert.equal(measurements.at(-1)?.resultCustodyAfterCommit, 0);
    } finally {
      await finish;
      await turn;
    }
    await delay(Math.max(0, holdMs + 1200 - (performance.now() - began)));
  }
} finally {
  writeGatewayGcTraceMarker("diagnostics-stop", profilePath);
  loop.disable();
  observer.disconnect();
  await logging.flushLogger();
  await database.closeOpenClawAgentDatabasesAsync(root);
}
const cpu = process.cpuUsage(cpuStart);
const logs = (await readFile(logPath, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const waits = logs.flatMap((record) => {
  const fields = Object.values(record).find(
    (value): value is Record<string, unknown> =>
      typeof value === "object" &&
      value !== null &&
      Reflect.get(value, "mutationKind") === "background-result" &&
      "lifecycleQueueWaitMs" in value,
  );
  return fields ? [fields.lifecycleQueueWaitMs] : [];
});
assert.equal(waits.length, samples, "Every sample must emit a lifecycle queue wait diagnostic");
const report = {
  samples,
  holdMs,
  measurements,
  lifecycleQueueWaitMs: waits,
  cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
  gc,
  promotion: readGatewayGcTrace(values["gc-log"], profilePath, "diagnostics"),
  eventLoop: {
    count: loop.count,
    p95Ms: loop.percentile(95) / 1e6,
    p99Ms: loop.percentile(99) / 1e6,
    maxMs: loop.max / 1e6,
  },
};
await writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
