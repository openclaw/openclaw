/**
 * Non-OCM update.status discovery cost with a synthetic 163-key environment and
 * 40 configured plugins. No Gateway, subprocess, registry, or live state access.
 * Run on each revision: node --import ./scripts/tsx.mjs scripts/perf/update-manager-measure.ts <label>
 * Timing and sampled-allocation passes are separate; each has four 5,000-call batches.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { initializePublishedConfigRuntimeEnv } from "../../src/config/config-env-vars.js";
import { resolveOcmUpdateManager } from "../../src/infra/ocm-update-client.js";

const synthetic = Object.fromEntries(
  Array.from({ length: 160 }, (_, i) => [`FIXTURE_ENV_${i}`, `synthetic-${i}`]),
);
// Retain Node's native environment access cost without measuring real credentials.
for (const key of Object.keys(process.env)) {
  delete process.env[key];
}
Object.assign(process.env, {
  ...synthetic,
  PATH: "/usr/bin:/bin",
  HOME: `${process.cwd()}/.local/update-manager-measure/home`,
  OPENCLAW_STATE_DIR: `${process.cwd()}/.local/update-manager-measure/state`,
});
const config = {
  env: { vars: Object.fromEntries(Object.entries(synthetic).slice(0, 40)) },
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`fixture-${i}`, { enabled: true }]),
    ),
  },
};
initializePublishedConfigRuntimeEnv(config, { ownedEnv: config.env.vars });
for (let i = 0; i < 100; i++) {
  assert.equal(await resolveOcmUpdateManager(), null);
}
const inspector = new Session();
inspector.connect();
const samples = [];
try {
  for (const mode of ["timing", "allocation"] as const) {
    for (let round = 0; round < 4; round++) {
      if (mode === "allocation") {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpu = process.threadCpuUsage();
      const start = performance.now();
      for (let i = 0; i < 5000; i++) {
        assert.equal(await resolveOcmUpdateManager(), null);
      }
      const wallMs = performance.now() - start;
      const used = process.threadCpuUsage(cpu);
      let sampledBytes: number | undefined;
      if (mode === "allocation") {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
      }
      samples.push({
        mode,
        round,
        calls: 5000,
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        sampledBytes,
      });
    }
  }
} finally {
  inspector.disconnect();
}
console.log(JSON.stringify({ label: process.argv[2], envKeys: 163, plugins: 40, samples }));
