/**
 * Catalog transport + worker context-identity microbenchmark (not a Gateway workload).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/prepared-catalog-handoff-measure.ts \
 *   --mode baseline --iterations 2000 [--allocations]
 * Repeat with --mode candidate, alternating order. Allocation sampling is a separate pass.
 * Uses 40 synthetic plugin manifests with 100 models each and the production input builder.
 * Baseline clones the complete input and fingerprints it in the worker; candidate hands off
 * the existing generation fingerprint and clones only request-local inputs after acknowledgement.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";
import {
  fingerprintPreparedModelCatalogPluginContext,
  prepareModelCatalogWorkerContext,
} from "../../src/agents/prepared-model-catalog-fingerprints.js";
import { createPreparedModelCatalogWorkerInput } from "../../src/agents/prepared-model-catalog-worker.js";
import type { PreparedModelCatalogWorkerTask } from "../../src/agents/prepared-model-catalog-worker.types.js";
import { AuthStorage } from "../../src/agents/sessions/auth-storage.js";
import { captureRuntimeConfig } from "../../src/config/runtime-source-projection.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.mode === "baseline" || values.mode === "candidate", "Pass --mode baseline|candidate");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 2000,
});
const providers = 40;
const modelsPerProvider = 100;
const metadata = createPluginMetadataSnapshotFixture({
  plugins: Array.from({ length: providers }, (_, provider) => ({
    id: `fixture-${provider}`,
    providers: [`fixture-${provider}`],
    modelCatalog: {
      providers: {
        [`fixture-${provider}`]: {
          api: "openai-completions",
          baseUrl: "https://synthetic.invalid/v1",
          models: Array.from({ length: modelsPerProvider }, (_unused, model) => ({
            id: `model-${model}`,
            name: `Synthetic provider ${provider} model ${model}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          })),
        },
      },
    },
  })),
});
const config = captureRuntimeConfig({
  agents: {
    entries: Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`fixture-${i}`, { name: `Synthetic ${i}` }]),
    ),
  },
});
const input = createPreparedModelCatalogWorkerInput({
  agentFacts: {
    input: { config, agentDir: "/synthetic/agent", workspaceDir: "/synthetic/workspace", env: {} },
    env: {},
    authStore: { version: 1, profiles: {} },
    credentials: {},
    providerIds: [],
    configuredModelRefs: [],
    configuredRuntimeModels: [],
    runtimeCapabilityModels: [],
    configuredGeneratedCatalogPluginIds: [],
    templateAuthStorage: AuthStorage.inMemory({}),
  },
  pluginMetadataSnapshot: metadata,
});
const context = prepareModelCatalogWorkerContext(input);
const { remoteCatalog, pluginMetadataSnapshot, ...requestInput } = input;
const request: PreparedModelCatalogWorkerTask["request"] = {
  kind: "catalog",
  syntheticAuth: [],
  clawInstallSchemaVersions: {
    path: "/synthetic/state.sqlite",
    snapshot: { kind: "ready", schemaVersions: [] },
  },
};
const full = { value: input, request };
const handoff: PreparedModelCatalogWorkerTask = { context, value: requestInput, request };
let checksum = 0;
const run = () => {
  if (values.mode === "baseline") {
    const cloned = structuredClone(full);
    assert.equal(fingerprintPreparedModelCatalogPluginContext(cloned.value), context.fingerprint);
    checksum += cloned.value.pluginMetadataSnapshot.plugins.length;
  } else {
    const cloned = structuredClone(handoff);
    assert.notEqual(cloned.value.input.config, input.input.config);
    const restored = { ...cloned.value, remoteCatalog, pluginMetadataSnapshot };
    checksum += restored.pluginMetadataSnapshot.plugins.length;
  }
};
for (let i = 0; i < 20; i++) {
  run();
}
global.gc?.();
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const loadStart = os.loadavg();
const cpuStart = process.cpuUsage();
const started = performance.now();
for (let i = 0; i < iterations; i++) {
  run();
}
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
let sampledAllocationBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledAllocationBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode: values.mode,
    allocations: values.allocations,
    iterations,
    providers,
    modelsPerProvider,
    fullInputBytes: serialize(full).byteLength,
    handoffBytes: serialize(handoff).byteLength,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sampledAllocationBytes,
    sampledAllocationBytesPerOperation:
      sampledAllocationBytes === undefined ? undefined : sampledAllocationBytes / iterations,
    checksum,
    loadStart,
    loadEnd: os.loadavg(),
  }),
);
