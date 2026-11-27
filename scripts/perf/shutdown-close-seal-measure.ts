// Synthetic process-boundary reproduction of a late successful Gateway close step.
// Copy shutdown-loaded-fixture.mjs's output to a fresh path for each run, then:
// node --import ./scripts/tsx.mjs scripts/perf/shutdown-close-seal-measure.ts \
//   --state-dir <copy> --output <new-directory> --hold-ms 6000 [--allocations]
// The injected scheduler delay models slow settlement, not a production owner attribution.
// No production state, external model, or external channel is used. SIGKILL at 15s bounds
// a stranded baseline; snapshots distinguish pending work from skipped retirement.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    "hold-ms": { type: "string", default: "6000" },
    allocations: { type: "boolean" },
  },
});
assert(values["state-dir"] && values.output);
const root = path.resolve(values["state-dir"]);
const output = path.resolve(values.output);
const shape = JSON.parse(readFileSync(path.join(root, "shape.json"), "utf8"));
assert(shape.sessions >= 5000 && shape.workspaceFiles === 62000);
const holdMs = parseStrictIntegerOption({
  raw: values["hold-ms"],
  label: "--hold-ms",
  min: 0,
  fallback: 6000,
});
assert(holdMs < 15000);
mkdirSync(output);
const configPath = path.join(root, "openclaw.json");
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, {
    startupTrace: true,
    restartTrace: true,
  }),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_NO_RESPAWN: "1",
};
const port = await getFreePort();
writeFileSync(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: { enabled: true, allow: [], slots: { memory: "none" } },
    gateway: { ...BASE_GATEWAY_BENCH_CONFIG.gateway, port, reload: { mode: "off" } },
    logging: { level: "info", file: path.join(output, "gateway.jsonl") },
  }),
);
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { assertSqliteIntegrity } = await import("../../src/infra/sqlite-integrity.js");
const { DatabaseSync } = await import("node:sqlite");
const seeded = openOpenClawAgentDatabase({ agentId: "main", env: process.env });
assert(seeded.db instanceof DatabaseSync);
assertSqliteIntegrity(seeded.db, "synthetic shutdown fixture", { check: "full" });
await closeOpenClawAgentDatabasesAsync();
await closeOpenClawStateDatabaseAsync();

const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { runGatewayLoop } = await import("../../src/cli/gateway-cli/run-loop.js");
const { runCliWithExitFinalization } = await import("../../src/cli/one-shot-exit.js");
const { startGatewayServerCore } = await import("../../src/gateway/server-start.js");
const { readSqliteCleanCloseSeal } = await import("../../src/infra/sqlite-clean-close-seal.js");
const { formatGatewayPendingCloseSteps } = await import("../../src/gateway/restart-trace.js");
const { replaceSessionEntry } = await import("../../src/config/sessions/session-accessor.js");
const inspector = new Session();
let start = 0;
let cpu = process.threadCpuUsage();
const snapshots: unknown[] = [];
function snapshot(phase: string) {
  const usage = process.threadCpuUsage(cpu);
  snapshots.push({
    phase,
    elapsedMs: performance.now() - start,
    cpuMs: (usage.user + usage.system) / 1000,
    memory: process.memoryUsage(),
    resources: process.getActiveResourcesInfo(),
    pending: formatGatewayPendingCloseSteps(),
    seal: Boolean(readSqliteCleanCloseSeal(seeded.path, statSync(seeded.path, { bigint: true }))),
  });
  writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        shape,
        holdMs,
        hostLoad: loadavg(),
        snapshots,
      },
      null,
      2,
    ),
  );
}
await runCliWithExitFinalization({
  run: async () => {
    process.exitCode = await runGatewayLoop({
      ownsProcessLifecycle: true,
      lockPort: port,
      start: async (options) => {
        const server = await startGatewayServerCore(port, {
          hostLifecycle: options?.hostLifecycle,
          startupOperation: options?.startupOperation,
          sidecarStartup: "defer",
          bind: "loopback",
          controlUiEnabled: false,
        });
        await server.startupSettled;
        openOpenClawAgentDatabase({ agentId: "main", env: process.env });
        await replaceSessionEntry(
          {
            agentId: "main",
            storePath: path.join(root, "agents/main/sessions/sessions.json"),
            sessionKey: "agent:main:dashboard:close-seal-proof",
          },
          { sessionId: "synthetic-close-seal", updatedAt: Date.now() },
        );
        assert(!readSqliteCleanCloseSeal(seeded.path, statSync(seeded.path, { bigint: true })));
        if (values.allocations) {
          await startCollectedHeapSampling(inspector, 32768);
        }
        setImmediate(() => {
          start = performance.now();
          cpu = process.threadCpuUsage();
          const stop = mock.method(
            GatewayScheduler.prototype,
            "stop",
            async function (this: InstanceType<typeof GatewayScheduler>) {
              stop.mock.restore();
              await this.stop();
              await delay(holdMs);
            },
          );
          snapshot("signal");
          setTimeout(() => snapshot("after-late-settlement"), 8000).unref();
          setTimeout(() => {
            snapshot("forced-exit");
            process.kill(process.pid, "SIGKILL");
          }, 15000).unref();
          process.kill(process.pid, "SIGTERM");
        });
        return server;
      },
    });
    snapshot("loop-returned");
    if (values.allocations) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      writeFileSync(
        path.join(output, "allocations.json"),
        JSON.stringify({
          bytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
        }),
      );
      inspector.disconnect();
    }
    process.once("exit", () => snapshot("exit"));
  },
  onError: (error) => {
    throw error;
  },
});
