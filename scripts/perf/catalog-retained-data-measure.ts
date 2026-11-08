/**
 * Warm catalog retained-data census: 40 providers and 10,000 immutable remote models.
 * Run timing and allocation separately, alternating baseline/candidate launches:
 * node --import ./scripts/tsx.mjs scripts/perf/catalog-retained-data-measure.ts
 *   [--owner-file /absolute/baseline-owner.ts] [--iterations 3000]
 *   [--allocation [--profile /absolute/census.heapprofile]]
 * --owner-file replaces only the production census owner, preserving its import URLs.
 * This owner microbenchmark excludes Gateway startup, task transport, and idle timers.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { PreparedModelRuntimePluginGeneration } from "../../src/agents/prepared-model-runtime.types.js";
import type { ActiveRemoteModelCatalog } from "../../src/model-catalog/remote-overlay.js";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
    profile: { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
assert(!values.profile || values.allocation, "--profile requires --allocation");
const ownerUrl = new URL(
  "../../src/agents/prepared-model-catalog-retained-data.ts",
  import.meta.url,
);
const wasOwnerReplaced = registerPerfOwnerReplacement(ownerUrl.href, values["owner-file"]);
const { measurePreparedCatalogRetainedData } =
  await import("../../src/agents/prepared-model-catalog-retained-data.js");
assert(
  !values["owner-file"] || wasOwnerReplaced(),
  "Requested census owner replacement was not loaded",
);
const { createPluginMetadataSnapshotFixture } =
  await import("../../src/plugins/plugin-metadata.test-support.js");
const { freezeJsonSnapshot } = await import("../../src/shared/immutable-data.js");
const providers = 40;
const modelsPerProvider = 250;
const remoteCatalog: ActiveRemoteModelCatalog = freezeJsonSnapshot({
  sourceUrl: "https://catalog.invalid",
  revision: "fixture",
  generatedAt: 1,
  providers: Object.fromEntries(
    Array.from({ length: providers }, (_, provider) => [
      `provider-${provider}`,
      {
        api: "openai-completions",
        baseUrl: "https://fixture.invalid",
        models: Array.from({ length: modelsPerProvider }, (_model, index) => ({
          id: `model-${index}`,
          name: `Model ${index}`,
          contextWindow: 128000,
          maxTokens: 8192,
          input: ["text"],
          cost: { input: 1, output: 2 },
        })),
      },
    ]),
  ),
  recommendations: {},
  pricing: {},
  upstreamPricing: {},
});
const generations: PreparedModelRuntimePluginGeneration[] = [
  {
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: Array.from({ length: providers }, (_, index) => ({
        id: `provider-${index}`,
        providers: [`provider-${index}`],
      })),
    }),
    remoteCatalog,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  },
];
const expected = measurePreparedCatalogRetainedData(generations, undefined);
let census = expected;
const inspector = values.allocation ? new Session() : undefined;
try {
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const started = performance.now();
  const cpuBefore = process.cpuUsage();
  for (let iteration = 0; iteration < iterations; iteration++) {
    census = measurePreparedCatalogRetainedData(generations, undefined);
  }
  const cpu = process.cpuUsage(cpuBefore);
  const elapsedMs = performance.now() - started;
  const profile = inspector
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  assert.deepEqual(census, expected, "An unchanged catalog must retain the same census");
  if (profile && values.profile) {
    fs.writeFileSync(path.resolve(values.profile), JSON.stringify(profile), { flag: "wx" });
  }
  console.log(
    JSON.stringify({
      mode: values.allocation ? "allocation" : "timing",
      iterations,
      providers,
      models: providers * modelsPerProvider,
      elapsedMs,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      cpu,
      cpuMs: (cpu.user + cpu.system) / 1000,
      allocation: profile
        ? {
            sampledBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
            samples: profile.samples.length,
            samplingInterval: 32768,
            includesCollectedObjects: true,
          }
        : undefined,
      digest: createHash("sha256").update(JSON.stringify(census)).digest("hex"),
      census,
    }),
  );
} finally {
  inspector?.disconnect();
}
