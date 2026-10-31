/**
 * Measure scoped startup preparation after the boot-wide legacy inspection.
 * Five configured agents, 10,000 finished sessions and a retired main store.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/startup-agent-preparation-measure.ts \
 *   --state-dir "$PWD/.local/startup-preparation-candidate" --iterations 2000
 * Repeat with --allocations; sampling and timing use separate processes.
 * --owner accepts a historical startup-migration-runtime.ts copied beside its original
 * so relative imports use the same dependencies. Alternate baseline/candidate.
 * Report main-thread CPU, sampled main-thread allocation and wall time per
 * preparation. Fixture writes and the initial global inspection are excluded.
 * This measures the owner, not connection latency or interrupted-turn recovery.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    owner: { type: "string" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean" },
  },
});
assert(values["state-dir"] && global.gc);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const stateDir = path.resolve(values["state-dir"]);
await mkdir(stateDir, { mode: 0o700 });
const owner = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../src/config/sessions/startup-migration-runtime.ts", import.meta.url);
const ownerSha256 = createHash("sha256")
  .update(await readFile(owner))
  .digest("hex");
const syntheticEnv = {
  PATH: process.env.PATH,
  HOME: stateDir,
  OPENCLAW_HOME: stateDir,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  TMPDIR: stateDir,
};
for (const key of Object.keys(process.env)) {
  delete process.env[key];
}
Object.assign(process.env, syntheticEnv);
const inspector = new Session();
const { cleanupSessionStateForTest } =
  await import("../../src/test-utils/session-state-cleanup.js");
try {
  const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
  const { runOpenClawAgentWriteTransaction } = await import("../../src/state/openclaw-agent-db.js");
  const { writeSessionEntry } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
  const { runSessionStartupMigration } = (await import(
    owner.href
  )) as typeof import("../../src/config/sessions/startup-migration-runtime.js");
  const agentIds = Array.from({ length: 5 }, (_, index) => `fleet-${index}`);
  const cfg = {
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
    },
  };
  setRuntimeConfigSnapshot(cfg);
  for (const agentId of [...agentIds, "main"]) {
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < (agentId === "main" ? 1 : 2_000); index++) {
          writeSessionEntry(database, `agent:${agentId}:dashboard:retained-${index}`, {
            sessionId: `${agentId}-${index}`,
            updatedAt: 1_790_000_000_000,
            status: "done",
          });
        }
      },
      { agentId, env: process.env },
    );
  }
  let warnings = 0;
  const log = {
    info() {},
    warn() {
      warnings++;
    },
  };
  const options = { cfg, env: process.env, log, handoffDatabase: async () => {} };
  await runSessionStartupMigration(options);
  assert(warnings > 0, "boot must report the unresolved legacy owner");
  const prepare = (index: number) =>
    runSessionStartupMigration({
      ...options,
      agentIds: new Set([agentIds[index % agentIds.length]!]),
    });
  for (let index = 0; index < agentIds.length; index++) {
    await prepare(index);
  }
  global.gc();
  inspector.connect();
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  warnings = 0;
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    await prepare(index);
  }
  const wallMs = performance.now() - start;
  const usedCpu = process.threadCpuUsage(cpu);
  let allocationBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocationBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  console.log(
    JSON.stringify({
      ownerSha256,
      iterations,
      configuredAgents: agentIds.length,
      sessions: 10_001,
      mainThreadCpuMs: (usedCpu.user + usedCpu.system) / 1000,
      wallMs,
      allocationBytes,
      repeatedWarnings: warnings,
      hostLoad: os.loadavg(),
      node: process.version,
    }),
  );
} finally {
  inspector.disconnect();
  await cleanupSessionStateForTest({ stateDir });
  await rm(stateDir, { recursive: true });
}
