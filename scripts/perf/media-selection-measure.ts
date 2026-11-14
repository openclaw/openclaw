// Owner microbenchmark: 40 synthetic plugins and 32 mixed-media attachments.
// OPENCLAW_STATE_DIR="$PWD/.local/media-bench" node --expose-gc --import ./scripts/tsx.mjs \
//   scripts/perf/media-selection-measure.ts timing 5000
// Repeat with allocation; alternate base/candidate at least five times. For baseline
// source overlays use OPENCLAW_BENCH_BASELINE_DIR and the existing
// --import ./scripts/perf/worker-retained-heap-preload.ts. Setup is untimed; allocation
// includes collected objects. CPU/GC use a separate untraced pass. No Gateway claims.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver, type PerformanceNodeEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { OpenClawConfig } from "../../src/config/types.js";
import { selectAttachments } from "../../src/media-understanding/attachments.select.js";
import { resolveAutoMediaKeyProviders } from "../../src/media-understanding/defaults.js";
import type {
  MediaAttachment,
  MediaUnderstandingProvider,
} from "../../src/media-understanding/types.js";
import { prepareRuntimePluginsConfig } from "../../src/plugins/config-state.js";
import { setGatewayPluginMetadataSnapshot } from "../../src/plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../src/plugins/current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../src/plugins/installed-plugin-index-policy.js";
import { finalizePluginMetadataSnapshot } from "../../src/plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";

const [mode = "timing", rawIterations = "5000"] = process.argv.slice(2);
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
assert(process.env.OPENCLAW_STATE_DIR, "Set an isolated OPENCLAW_STATE_DIR");
const providers: MediaUnderstandingProvider[] = Array.from({ length: 40 }, (_, index) => ({
  id: index === 0 ? "minimax" : `synthetic-${String(index).padStart(2, "0")}`,
  capabilities: ["image"],
  autoPriority: { image: 40 - index },
}));
const registry = new Map(providers.map((provider) => [provider.id, provider]));
const plugins = providers.map(({ id, capabilities, autoPriority }) => ({
  id,
  contracts: { mediaUnderstandingProviders: [id] },
  mediaUnderstandingProviderMetadata: { [id]: { capabilities, autoPriority } },
}));
const config: OpenClawConfig = {
  plugins: { allow: providers.map(({ id }) => id) },
  models: {
    providers: {
      "minimax-cn": {
        baseUrl: "https://example.invalid",
        models: [
          {
            id: "synthetic-image",
            name: "Synthetic",
            input: ["text", "image"],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 4096,
          },
        ],
      },
    },
  },
};
prepareRuntimePluginsConfig(config);
setGatewayPluginMetadataSnapshot(
  finalizePluginMetadataSnapshot(
    createPluginMetadataSnapshotFixture({ plugins }, resolveInstalledPluginIndexPolicyHash(config)),
  ),
  { config },
);
const attachments: MediaAttachment[] = Array.from({ length: 32 }, (_, index) => ({
  index,
  kind: index % 4 === 0 ? "audio" : "image",
  path: `/synthetic/attachment-${index}`,
}));
const scenarios = [
  {
    name: "provider-priorities",
    run: () => resolveAutoMediaKeyProviders({ capability: "image", providerRegistry: registry }),
    expected: 40,
  },
  {
    name: "configured-aliases",
    run: () => resolveAutoMediaKeyProviders({ capability: "image", cfg: config }),
    expected: 41,
  },
  {
    name: "last-attachments",
    run: () =>
      selectAttachments({
        capability: "image",
        attachments,
        policy: { prefer: "last", mode: "all", maxAttachments: 8 },
      }).selected,
    expected: 8,
  },
];
const inspector = new Session();
if (mode === "allocation") {
  inspector.connect();
}
try {
  for (const scenario of scenarios) {
    for (let index = 0; index < 500; index++) {
      assert.equal(scenario.run().length, scenario.expected);
    }
    global.gc();
    await nextTurn();
    const gcEvents: Array<{ start: number; duration: number; kind: number }> = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcEvents.push({
          start: entry.startTime,
          duration: entry.duration,
          kind: (entry as PerformanceNodeEntry).detail.kind,
        });
      }
    });
    if (mode === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    } else {
      observer.observe({ entryTypes: ["gc"] });
    }
    const hostLoad = loadavg();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    let observed = 0;
    for (let index = 0; index < iterations; index++) {
      observed += scenario.run().length;
    }
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    await nextTurn();
    await nextTurn();
    observer.disconnect();
    // Observer delivery is asynchronous; count only collections started in the work window.
    const gc = gcEvents.filter((event) => event.start >= start && event.start < start + wallMs);
    const sampledBytes =
      mode === "allocation"
        ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
            (sum, sample) => sum + sample.size,
            0,
          )
        : undefined;
    assert.equal(observed, iterations * scenario.expected);
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        mode,
        iterations,
        node: process.version,
        hostLoad,
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        sampledBytes,
        bytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
        gcMs: gc.reduce((sum, event) => sum + event.duration, 0),
        maxGcMs: Math.max(0, ...gc.map((event) => event.duration)),
        gcCount: gc.length,
        gc,
        outsideWindowGc: gcEvents.filter((event) => !gc.includes(event)),
        memory: process.memoryUsage(),
      }),
    );
  }
} finally {
  inspector.disconnect();
  clearCurrentPluginMetadataSnapshot();
  prepareRuntimePluginsConfig(null);
}
