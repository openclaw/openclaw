// Catalog refresh owner microbenchmark: 40 plugins, native-admission overlays, 100 calls/batch.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/installed-plugin-index-fingerprint-measure.ts
// [--allocation]. Run the same script on base/candidate; CPU and allocation passes are separate.
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { fingerprintPreparedModelCatalogPluginContext } from "../../src/agents/prepared-model-catalog-fingerprints.js";
import { createPreparedModelCatalogWorkerInput } from "../../src/agents/prepared-model-catalog-worker.js";
import { AuthStorage } from "../../src/agents/sessions/auth-storage.js";
import { captureRuntimeConfig } from "../../src/config/runtime-source-projection.js";
import { createPluginCache, withPluginCache } from "../../src/plugins/plugin-cache.js";
import { finalizePluginMetadataSnapshot } from "../../src/plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";

const allocation = process.argv.includes("--allocation");
const calls = 2000;
const plugins = 40;
const cache = createPluginCache();
await withPluginCache(cache, async () => {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: Array.from({ length: plugins }, (_, i) => ({ id: `fixture-${i}` })),
  });
  for (const plugin of snapshot.index.plugins) {
    plugin.contributions = {
      channels: [],
      channelConfigs: [],
      providers: [plugin.pluginId],
      modelCatalogProviders: [],
      modelSupportPrefixes: [],
      modelSupportPatterns: [],
      autoEnableProviderIds: [],
      commandAliases: [],
      contracts: {},
    };
    plugin.sourceAdmissions = {
      [`${plugin.rootDir}\0catalog`]: {
        signature: "synthetic",
        sourceDigest: "a".repeat(64),
        nativeArtifacts: {},
        nativeNamespaces: {},
      },
    };
  }
  finalizePluginMetadataSnapshot(snapshot);
  const params: Parameters<typeof createPreparedModelCatalogWorkerInput>[0] = {
    pluginMetadataSnapshot: snapshot,
    agentFacts: {
      input: { config: captureRuntimeConfig({}), agentDir: "/synthetic/catalog-agent" },
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
  };
  const fingerprint = () =>
    fingerprintPreparedModelCatalogPluginContext(createPreparedModelCatalogWorkerInput(params));
  const expected = fingerprint();
  const batch = (count: number) => {
    for (let i = 0; i < count; i++) {
      assert.equal(fingerprint(), expected);
    }
  };
  batch(200);
  globalThis.gc?.();
  const inspector = new Session();
  if (allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const started = performance.now();
  const cpuStart = process.threadCpuUsage();
  for (let i = 0; i < calls / 100; i++) {
    batch(100);
  }
  const cpu = process.threadCpuUsage(cpuStart);
  const elapsedMs = performance.now() - started;
  let bytesPerCall: number | undefined;
  if (allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    bytesPerCall = sum(profile.head) / calls;
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      calls,
      plugins,
      allocation,
      fingerprint: expected,
      elapsedMs,
      cpuUsPerCall: (cpu.user + cpu.system) / calls,
      bytesPerCall,
      memory: process.memoryUsage(),
      hostLoad: loadavg(),
    }),
  );
});
