// Synthetic state only: create it with scripts/perf/team-shape-fixture.ts first.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/talk-shutdown-measure.ts --state-dir <fixture>
// Compare interleaved revisions; --idle is the clean-close A/A control.
// --allocations is a separate sampled-allocation pass. This is a socket-free
// Gateway lifecycle measurement, not provider, model, or whole-process exit proof.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    idle: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "--state-dir must name a synthetic Team-shape fixture");
assert(global.gc, "Run with --expose-gc");
const stateDir = path.resolve(values["state-dir"]);
const fixture = JSON.parse(await readFile(path.join(stateDir, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1");
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), path.join(stateDir, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: stateDir,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
};
// State resolvers capture environment during import.
const { createGatewayKernel } = await import("../../src/gateway/server-kernel.js");
const { runGatewayCloseSteps, isGatewayCleanupRetainedError } =
  await import("../../src/gateway/server-shutdown.js");
const { withClientVoiceSessionSettlement } =
  await import("../../src/talk/client-voice-session-lifecycle.js");
const kernel = await createGatewayKernel(40967, { sidecarStartup: "defer", bind: "loopback" });
const release = Promise.withResolvers<void>();
// Fault entry precedes measurement: an accepted Talk persistence operation
// remains held until the measured deadline, then the fixture releases custody.
const persistence = values.idle
  ? Promise.resolve()
  : withClientVoiceSessionSettlement(() => release.promise);
const measured = Promise.withResolvers<string>();
const warnings: string[] = [];
const inspector = new Session();
let cutoff: ReturnType<typeof setTimeout> | undefined;
let closing: Promise<void> | undefined;
let prepareMs: number | undefined;
try {
  global.gc();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  cutoff = setTimeout(() => measured.resolve("cutoff"), 8_000);
  closing = kernel.prepareClose({ exitAfterClose: true }).then(async (close) => {
    prepareMs = performance.now() - started;
    await runGatewayCloseSteps({
      owner: kernel,
      exitAfterClose: true,
      close,
      onError: (message) => {
        warnings.push(message);
        if (/gateway close prelude cleanup exceeded.*talk-persistence/.test(message)) {
          measured.resolve("talk-grace");
        }
      },
    });
  });
  void closing.then(
    () => measured.resolve("clean"),
    () => measured.resolve("error"),
  );
  const outcome = await measured.promise;
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  console.log(
    JSON.stringify({
      outcome,
      idle: values.idle,
      allocations: values.allocations,
      sessionCount: fixture.sessionCount,
      agentDatabaseBytes: fixture.agentDatabaseBytes,
      node: process.version,
      platform: process.platform,
      hostLoad,
      prepareMs,
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      allocatedBytes: profile?.samples.reduce((sum, sample) => sum + sample.size, 0),
      heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
      warnings,
    }),
  );
} finally {
  clearTimeout(cutoff);
  release.resolve();
  inspector.disconnect();
  await persistence;
  await closing?.catch((error: unknown) => {
    if (!isGatewayCleanupRetainedError(error)) {
      throw error;
    }
  });
}
