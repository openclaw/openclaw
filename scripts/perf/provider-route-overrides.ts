/**
 * Measure route preparation with an already-established request override.
 * Run on each revision with the same Node version:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/provider-route-overrides.ts \
 *   --output .local/provider-route-overrides.json
 *
 * Synthetic fleet config: 40 plugins, 100 agents, 8 providers × 25 models.
 * Cloned runtime inputs exercise authored-source projection; captured inputs are
 * the existing constant-time control. Timing and allocation use separate passes.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../src/config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../../src/config/runtime-source-projection.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createProviderModelRoutesResolver } from "../../src/plugins/provider-model-routes.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    output: { type: "string" },
  },
});
const iterations = Number(values.iterations);
if (!values.output || !globalThis.gc || !Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("Use --expose-gc, --output <path>, and a positive --iterations count.");
}
const source: OpenClawConfig = {
  agents: {
    entries: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`agent-${index}`, { model: "fixture-0/model-0" }]),
    ),
  },
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `plugin-${index}`,
        {
          enabled: true,
          config: { nested: { settings: Array.from({ length: 20 }, (_setting, i) => i) } },
        },
      ]),
    ),
  },
  models: {
    providers: Object.fromEntries(
      Array.from({ length: 8 }, (_, provider) => [
        `fixture-${provider}`,
        {
          baseUrl: "https://provider.example.test/v1",
          api: "openai-completions",
          models: Array.from({ length: 25 }, (_model, model) => ({
            id: `model-${model}`,
            name: `Model ${model}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          })),
        },
      ]),
    ),
  },
};
const runtime: OpenClawConfig = { ...structuredClone(source), gateway: { mode: "local" } };
setRuntimeConfigSnapshot(runtime, source);
const inspector = new Session();
inspector.connect();
const results = [];
try {
  for (const [shape, config] of [
    ["cloned", structuredClone(runtime)],
    ["captured", captureRuntimeConfig(runtime)],
  ] as const) {
    const run = () => {
      const resolve = createProviderModelRoutesResolver({
        provider: "fixture-0",
        config,
        requestTransportOverrides: "present",
        env: {},
        surface: {
          resolveModelRoutes: (context) => {
            assert.equal(context.requestTransportOverrides, "present");
            return { kind: "indeterminate" };
          },
        },
      });
      assert.equal(resolve({ modelId: "model-0" })?.kind, "indeterminate");
    };
    for (let index = 0; index < 100; index++) {
      run();
    }
    const timing = [];
    for (let round = 0; round < 5; round++) {
      globalThis.gc();
      const hostLoad = loadavg();
      const cpu = process.cpuUsage();
      const started = performance.now();
      for (let index = 0; index < iterations; index++) {
        run();
      }
      const elapsedMs = performance.now() - started;
      const usage = process.cpuUsage(cpu);
      timing.push({ elapsedMs, cpuMs: (usage.user + usage.system) / 1000, hostLoad });
    }
    globalThis.gc();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let index = 0; index < iterations; index++) {
      run();
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    const comparisonBytes = (node: typeof profile.head): number =>
      (node.callFrame.url === "node:internal/util/comparisons" ? node.selfSize : 0) +
      node.children.reduce((sum, child) => sum + comparisonBytes(child), 0);
    results.push({
      shape,
      iterations,
      timing,
      allocatedBytes,
      comparisonBytes: comparisonBytes(profile.head),
      bytesPerOperation: allocatedBytes / iterations,
    });
  }
  writeFileSync(values.output, `${JSON.stringify({ node: process.version, results }, null, 2)}\n`);
} finally {
  inspector.disconnect();
  resetConfigRuntimeState();
}
