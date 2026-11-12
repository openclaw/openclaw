/**
 * Replays model-fallback preparation with 40 plugin entries and six configured channels.
 * ClickClack needs auto-enable to fill its missing enabled flag; one other plugin
 * is explicitly disabled. The same authored config is reused for every turn.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/model-fallback-activation-inputs.ts \
 *   --iterations 1000 [--flow runner|activation] [--allocation | --counts]
 *   [--config published|frozen] [--warmup 100] [--profile <output.cpuprofile>]
 * Run separate processes in A/A controls and five alternating AB/BA pairs. Accept
 * unchanged model selection, one materialization per config/metadata generation,
 * lower CPU/allocation beyond A/A spread, and no 20% worsening. Published mode
 * uses the live mutable config object returned by runtime config publication. Timing, coverage
 * counts, and sampled allocation are separate passes. This metadata-only path
 * does not read session rows or inventory workspace files: database/file sizes
 * do not affect the fixture. All config, paths, and models are synthetic. Each
 * operation crosses an event-loop turn; ownerWallUsPerRun excludes that boundary,
 * whereas CPU/allocation include the identical scheduler overhead in both arms.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { runWithModelFallback } from "../../src/agents/model-fallback-runner.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveBundledCompatActivationInputs } from "../../src/plugins/activation-context.js";
import { prepareRuntimePluginsConfig } from "../../src/plugins/config-state.js";
import { withPluginMetadataSnapshotScope } from "../../src/plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { freezeJsonSnapshot } from "../../src/shared/immutable-data.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "1000" },
    flow: { type: "string", default: "runner" },
    config: { type: "string", default: "published" },
    warmup: { type: "string" },
    allocation: { type: "boolean", default: false },
    counts: { type: "boolean", default: false },
    profile: { type: "string" },
  },
});
const iterations = Number(values.iterations);
const warmup = Number(values.warmup ?? (values.counts ? "0" : "100"));
assert(Number.isSafeInteger(warmup) && warmup >= 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const gc = globalThis.gc;
assert(gc, "Use --expose-gc");
assert(["runner", "activation"].includes(values.flow));
assert(["published", "frozen"].includes(values.config));
assert(!(values.allocation && values.counts), "Measure allocation and coverage separately");
const channels = ["clickclack", "discord", "nextcloud-talk", "reef", "slack", "x"];
const ids = [
  ...channels,
  "synthetic-provider",
  "synthetic-disabled",
  ...Array.from({ length: 32 }, (_, index) => `synthetic-plugin-${index}`),
];
const config: OpenClawConfig = {
  agents: {
    defaults: {
      model: {
        primary: "synthetic-provider/primary",
        fallbacks: ["synthetic-provider/fallback"],
      },
    },
  },
  models: {
    providers: {
      "synthetic-provider": {
        api: "openai-completions",
        auth: "api-key",
        baseUrl: "https://synthetic.invalid/v1",
        apiKey: "synthetic-fixture-key",
        models: ["primary", "fallback"].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4096,
        })),
      },
    },
  },
  channels: Object.fromEntries(
    channels.map((id) => [id, { enabled: true, dmPolicy: "allowlist" }]),
  ),
  plugins: {
    allow: ids,
    slots: { memory: "none" },
    entries: Object.fromEntries(
      ids.map((id, index) => [
        id,
        {
          ...(id === "clickclack" ? {} : { enabled: id !== "synthetic-disabled" }),
          config: { fixture: index },
        },
      ]),
    ),
  },
};
if (values.config === "published") {
  setRuntimeConfigSnapshot(config);
  assert.equal(getRuntimeConfigSnapshot(), config);
  assert.equal(Object.isFrozen(config), false);
} else {
  freezeJsonSnapshot(config);
  prepareRuntimePluginsConfig(config);
}
const snapshot = createPluginMetadataSnapshotFixture({
  plugins: ids.map((id) => ({
    id,
    origin: "config",
    rootDir: `/synthetic/${id}`,
    channels: channels.includes(id) ? [id] : [],
    channelCatalogMeta: { id, preferOver: ["unused-synthetic-predecessor"] },
  })),
});
snapshot.discovery = { candidates: [], diagnostics: [] };
const params = {
  cfg: config,
  provider: "synthetic-provider",
  model: "primary",
  skipAuthProfileRuntime: true,
  run: async (_provider: string, model: string) => model,
};
let result: Awaited<ReturnType<typeof runWithModelFallback<string>>> | undefined;
const activationParams = {
  rawConfig: config,
  env: process.env,
  applyAutoEnable: true,
  manifestRegistry: snapshot.manifestRegistry,
  discovery: snapshot.discovery,
  resolveBundledPluginIds: () => [],
};
let activation: ReturnType<typeof resolveBundledCompatActivationInputs> | undefined;
let ownerWallMs = 0;
async function run(count: number) {
  for (let iteration = 0; iteration < count; iteration++) {
    // Separate turns must not reuse the pre-existing same-turn auto-enable memo.
    await setImmediate();
    const ownerStart = performance.now();
    if (values.flow === "runner") {
      result = await runWithModelFallback(params);
    } else {
      activation = resolveBundledCompatActivationInputs(activationParams);
    }
    ownerWallMs += performance.now() - ownerStart;
  }
}
const inspector = new Session();
inspector.connect();
await withPluginMetadataSnapshotScope(
  snapshot,
  async () => {
    if (!values.counts) {
      await run(warmup);
    }
    gc();
    if (values.counts) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
    }
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32_768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    if (values.profile) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    ownerWallMs = 0;
    const hostLoadBefore = loadavg();
    const cpuBefore = process.cpuUsage();
    const threadBefore = process.threadCpuUsage();
    const start = performance.now();
    await run(iterations);
    const wallMs = performance.now() - start;
    const threadCpu = process.threadCpuUsage(threadBefore);
    const cpu = process.cpuUsage(cpuBefore);
    let sampledBytes: number | undefined;
    let rawSampleBytes: number | undefined;
    let activationSampledBytes = 0;
    let samples: number | undefined;
    let counts: Record<string, number> | undefined;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      let totalNodeBytes = 0;
      const visit = (node: typeof profile.head, inside = false) => {
        const inActivation =
          inside || node.callFrame.functionName === "resolveBundledCompatActivationInputs";
        totalNodeBytes += node.selfSize;
        if (inActivation) {
          activationSampledBytes += node.selfSize;
        }
        for (const child of node.children) {
          visit(child, inActivation);
        }
      };
      visit(profile.head);
      // V8 sample totals and tree aggregation can differ slightly across GC.
      // Use one typed aggregation for total and owner bytes; retain both readings.
      sampledBytes = totalNodeBytes;
      rawSampleBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
      samples = profile.samples.length;
    }
    if (values.counts) {
      const { result: coverage } = await inspector.post("Profiler.takePreciseCoverage");
      counts = {};
      for (const script of coverage) {
        for (const fn of script.functions) {
          if (
            [
              "resolveBundledCompatActivationInputs",
              "applyPluginAutoEnable",
              "materializePluginAutoEnableCandidatesInternal",
              "normalizePluginEntries",
            ].includes(fn.functionName)
          ) {
            const range = fn.ranges[0];
            assert(range, "V8 coverage omitted the function range");
            counts[fn.functionName] = (counts[fn.functionName] ?? 0) + range.count;
          }
        }
      }
      await inspector.post("Profiler.stopPreciseCoverage");
    }
    if (values.profile) {
      const { profile } = await inspector.post("Profiler.stop");
      writeFileSync(values.profile, JSON.stringify(profile));
    }
    if (values.flow === "runner") {
      assert.equal(result?.result, "primary");
      assert.equal(result?.model, "primary");
    } else {
      assert.equal(activation?.config?.plugins?.entries?.["synthetic-disabled"]?.enabled, false);
      assert.equal(activation?.config?.plugins?.entries?.clickclack?.enabled, true);
    }
    assert.equal(config.plugins?.entries?.["synthetic-disabled"]?.enabled, false);
    assert.equal(config.plugins?.entries?.clickclack?.enabled, undefined);
    console.log(
      JSON.stringify({
        ownerSha256: Object.fromEntries(
          ["plugins/activation-context.ts", "config/plugin-auto-enable.apply.ts"].map((file) => [
            file,
            hash("sha256", readFileSync(new URL(`../../src/${file}`, import.meta.url))),
          ]),
        ),
        node: process.version,
        flow: values.flow,
        configMode: values.config,
        mode: values.counts ? "counts" : values.allocation ? "allocation" : "timing",
        entries: ids.length,
        configuredChannels: channels.length,
        activationRewrites: 1,
        candidates: 2,
        iterations,
        warmup,
        ownerWallUsPerRun: (ownerWallMs * 1000) / iterations,
        wallMs,
        wallUsPerRun: (wallMs * 1000) / iterations,
        processCpuUsPerRun: (cpu.user + cpu.system) / iterations,
        mainThreadCpuUsPerRun: (threadCpu.user + threadCpu.system) / iterations,
        sampledBytes,
        rawSampleBytes,
        sampleMinusTreeBytes:
          rawSampleBytes !== undefined && sampledBytes !== undefined
            ? rawSampleBytes - sampledBytes
            : undefined,
        sampledBytesPerRun: sampledBytes === undefined ? undefined : sampledBytes / iterations,
        activationSampledBytesPerRun: values.allocation
          ? activationSampledBytes / iterations
          : undefined,
        samples,
        counts,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
      }),
    );
  },
  { config, trustConfigIdentity: true },
);
inspector.disconnect();
