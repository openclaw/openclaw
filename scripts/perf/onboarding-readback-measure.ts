/**
 * Synthetic SQLite owner microbenchmark, 40 recommendations per saved workspace.
 * Run on base, then candidate with the same Node runtime:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/onboarding-readback-measure.ts
 * Five warm passes of 2,000 reads; timing and sampled allocation run separately.
 * Fixtures and imports are outside measurement. This measures the worker kernel,
 * not Gateway latency or worker transport. No operator state or credentials.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../src/infra/kysely-sync.js";
import { writeConfigMachineStateInDatabase } from "../../src/state/config-machine-state-write.js";
import { prepareOnboardingRecommendationOffer } from "../../src/state/onboarding-recommendations.contract.js";
import { readOnboardingRecommendationsInDatabase } from "../../src/state/onboarding-recommendations.kernel.js";

const count = 2_000;
const prepared = prepareOnboardingRecommendationOffer({
  inventory: [{ label: "Synthetic workspace" }],
  answered: false,
  nowMs: 1_000,
  matches: Array.from({ length: 40 }, (_, index) => ({
    appLabel: `Application ${index}`,
    candidateId: `plugin-${index}`,
    tier: "recommended",
    reason: "Connect this installed application to the synthetic workspace.",
    candidate: {
      id: `plugin-${index}`,
      displayName: `Plugin ${index}`,
      summary: "Synthetic plugin recommendation",
      source: "official-plugin",
      downloads: 1_000,
    },
  })),
});
const record = {
  inventoryHash: prepared.inventoryHash,
  matches: prepared.matches,
  offeredAt: prepared.nowMs,
  acceptedAt: null,
  updatedAt: prepared.nowMs,
};
const db = new DatabaseSync(":memory:");
const inspector = new Session();
try {
  db.exec(`CREATE TABLE config_machine_state (
    state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
  ) STRICT`);
  writeConfigMachineStateInDatabase(db, "onboarding.recommendations.synthetic", record);
  const read = () =>
    readOnboardingRecommendationsInDatabase(db, "onboarding.recommendations.synthetic");
  assert.deepEqual(read(), record);
  for (let index = 0; index < 500; index++) {
    read();
  }
  const timings = [];
  for (let pass = 0; pass < 5; pass++) {
    globalThis.gc?.();
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let index = 0; index < count; index++) {
      read();
    }
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    timings.push({ elapsedMs, cpuMs: (used.user + used.system) / 1_000 });
  }
  inspector.connect();
  const allocations = [];
  for (let pass = 0; pass < 5; pass++) {
    globalThis.gc?.();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4_096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let index = 0; index < count; index++) {
      read();
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocations.push(profile.samples.reduce((sum, sample) => sum + sample.size, 0));
  }
  console.log(
    JSON.stringify({ node: process.version, load: loadavg(), count, timings, allocations }),
  );
} finally {
  inspector.disconnect();
  clearNodeSqliteKyselyCacheForDatabase(db);
  db.close();
}
