// Run unchanged on each revision, alternating base/candidate:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/model-suppression-resolver.ts
// --iterations 5000 --warmup 500; add --allocations for a separate allocation pass.
// Forty plugins, twenty suppression rules, forty configured providers, one stable
// config/snapshot and an already-materialized matching route. No model/network I/O.
// Compare untraced main-thread CPU/work and sampled bytes/work; traced timings are
// diagnostic only. This isolates the owner path, not whole-Gateway throughput.
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { materializePreparedRuntimeModel } from "../../src/agents/runtime-plan/materialize-model.js";
import type { AgentRuntimeAuthPlan } from "../../src/agents/runtime-plan/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "5000" },
    warmup: { type: "string", default: "500" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 5000,
});
const warmup = parseStrictIntegerOption({
  raw: values.warmup,
  label: "--warmup",
  min: 1,
  fallback: 500,
});
assert(global.gc, "Run with --expose-gc");
const providers = Array.from({ length: 40 }, (_, index) =>
  index === 0 ? "openai" : `fixture-${index}`,
);
const api = "openai-responses" as const;
const baseUrl = "https://provider-0.example/v1";
const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: providers.map((provider, index) => ({
    id: `plugin-${index}`,
    providers: [provider],
    providerEndpoints: [{ endpointClass: "native", hosts: [`provider-${index}.example`] }],
    modelCatalog: {
      providers: {
        [provider]: { api, baseUrl: `https://provider-${index}.example/v1`, models: [] },
      },
      suppressions:
        index < 10
          ? [0, 1].map((rule) => ({
              provider,
              model: `retired-${rule}`,
              retirement: { replacedBy: "current" },
              when: { baseUrlHosts: [`provider-${index}.example`], providerConfigApiIn: [api] },
            }))
          : [],
    },
  })),
});
const config: OpenClawConfig = {
  plugins: {
    entries: Object.fromEntries(
      providers.map((_, index) => [`plugin-${index}`, { enabled: true }]),
    ),
  },
  models: {
    providers: Object.fromEntries(
      providers.map((provider, index) => [
        provider,
        {
          api,
          baseUrl: `https://provider-${index}.example/v1`,
          models: [],
        },
      ]),
    ),
  },
};
const model = { provider: "openai", id: "fixture-current", api, baseUrl };
const plan: AgentRuntimeAuthPlan = {
  providerForAuth: "openai",
  authProfileProviderForAuth: "openai",
  selectedAuthMode: "api-key",
  modelRoute: {
    provider: model.provider,
    modelId: model.id,
    api,
    baseUrl,
    authRequirement: "api-key",
    requestTransportOverrides: "none",
  },
};
const request = {
  provider: model.provider,
  modelId: model.id,
  model,
  plan,
  config,
  metadataSnapshot,
  resolveModel: async () => {
    throw new Error("Matching model must not be resolved again");
  },
};
async function run(count: number) {
  let matches = 0;
  for (let index = 0; index < count; index++) {
    if ((await materializePreparedRuntimeModel(request)) === model) {
      matches++;
    }
  }
  assert.equal(matches, count);
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
const inspector = new Session();
try {
  await run(warmup);
  global.gc();
  await nextTurn();
  const hostLoadStart = loadavg();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  await run(iterations);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  console.log(
    JSON.stringify({
      mode: values.allocations ? "allocation" : "timing",
      iterations,
      warmup,
      pluginCount: providers.length,
      suppressionCount: 20,
      elapsedMs,
      mainThreadCpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      allocatedBytesPerOperation: profile ? allocated(profile.head) / iterations : undefined,
      hostLoadStart,
      hostLoadEnd: loadavg(),
      ...process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
}
