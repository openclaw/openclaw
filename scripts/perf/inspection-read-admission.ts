/**
 * Warm agent-read admission CPU/allocation probe (not whole-Gateway evidence).
 * Run on each source revision: node --import ./scripts/tsx.mjs
 * scripts/perf/inspection-read-admission.ts > /absolute/result.json
 * Five timing and five sampled-allocation rounds, 5,000 reads each alternating
 * halves of a 10,000-path inventory. The outer turn models a nested session read;
 * no files, workers, or operator state are opened. Compare counterbalanced runs.
 */
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { runWithSqliteDatabaseAdmissionTurn } from "../../src/infra/sqlite-database-admission-turn.js";
import { runWithAgentDatabaseReadAdmissionTurn } from "../../src/state/agent-database-admission.js";
import { getPendingOpenClawAgentDatabasePreparation } from "../../src/state/openclaw-agent-execution.js";

const paths = Array.from({ length: 10_000 }, (_, index) => `/synthetic/agent-${index}.sqlite`);
const iterations = 5_000;
const read = async () => undefined;
async function workload(offset = 0) {
  await runWithSqliteDatabaseAdmissionTurn([], async () => {
    for (let index = 0; index < iterations; index++) {
      void getPendingOpenClawAgentDatabasePreparation(
        paths[(offset + index) % paths.length]!,
        "read",
      );
      await runWithAgentDatabaseReadAdmissionTurn([], read);
    }
  });
}

await workload();
const samples = [];
for (const mode of ["timing", "allocation"] as const) {
  for (let round = 0; round < 5; round++) {
    const inspector = mode === "allocation" ? new Session() : undefined;
    inspector?.connect();
    try {
      await inspector?.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      const cpu = process.cpuUsage();
      const start = performance.now();
      await workload(round * iterations);
      const elapsedMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      const allocation = await inspector?.post("HeapProfiler.stopSampling");
      const bytes = allocation?.profile.samples.reduce((sum, sample) => sum + sample.size, 0);
      samples.push({
        mode,
        round,
        iterations,
        elapsedMs,
        cpuMs: (used.user + used.system) / 1000,
        sampledAllocatedBytes: bytes,
        hostLoad: os.loadavg(),
      });
    } finally {
      inspector?.disconnect();
    }
  }
}
console.log(JSON.stringify({ node: process.version, paths: paths.length, samples }, null, 2));
