/**
 * Plugin materialization owner benchmark, with 40 synthetic plugin entries and six channels.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-auto-enable-materialize.ts \
 *   --flow rewrite --iterations 1000 [--allocation] [--module <owner-path>]
 * Flows: published (prepared runtime policy), frozen (unchanged immutable snapshot),
 * mutable (unpublished config), rewrite (immutable input requiring one plugin rewrite).
 * Supply the baseline owner beside its source to preserve relative imports; remove it afterward.
 * Run A/A controls, then five alternating baseline/candidate pairs in separate processes.
 * Timing and allocation runs are separate; allocation includes minor/major collected objects.
 * Accept identical policy/disablement, reduced CPU/allocation beyond A/A spread, and no
 * 20% worsening. This owner takes supplied metadata and does not access sessions/workspaces;
 * database size and workspace file count are therefore outside this measurement.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { PluginAutoEnableCandidate } from "../../src/config/plugin-auto-enable.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { prepareRuntimePluginsConfig } from "../../src/plugins/config-state.js";
import type { PluginManifestRegistry } from "../../src/plugins/manifest-registry.types.js";
import { freezeJsonSnapshot } from "../../src/shared/immutable-data.js";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    flow: { type: "string", default: "rewrite" },
    iterations: { type: "string", default: "1000" },
    allocation: { type: "boolean", default: false },
  },
});
assert(["published", "frozen", "mutable", "rewrite"].includes(values.flow));
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "Use --expose-gc");
const modulePath = values.module
  ? resolve(values.module)
  : fileURLToPath(new URL("../../src/config/plugin-auto-enable.materialize.ts", import.meta.url));
const owner: typeof import("../../src/config/plugin-auto-enable.materialize.js") = await import(
  pathToFileURL(modulePath).href
);
const channels = ["clickclack", "discord", "nextcloud-talk", "reef", "slack", "x"];
const ids = [
  ...channels,
  "openai",
  "team-reports",
  ...Array.from({ length: 32 }, (_, index) => `fixture-plugin-${index}`),
];
const config: OpenClawConfig = {
  channels: Object.fromEntries(channels.map((id) => [id, { enabled: true }])),
  plugins: {
    allow: ids,
    entries: Object.fromEntries(
      ids.map((id, index) => [
        id,
        id === "team-reports"
          ? { enabled: false }
          : {
              ...(values.flow === "rewrite" && id === "clickclack" ? {} : { enabled: true }),
              config: { fixture: index },
            },
      ]),
    ),
  },
};
const manifestRegistry: PluginManifestRegistry = {
  diagnostics: [],
  plugins: ids.map((id) => ({
    id,
    channels: channels.includes(id) ? [id] : [],
    providers: id === "openai" ? [id] : [],
    // Explicit metadata avoids a cold external-catalog lookup for synthetic channels.
    channelCatalogMeta: { id, preferOver: ["unused-fixture-predecessor"] },
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "config",
    rootDir: `/synthetic/${id}`,
    source: `/synthetic/${id}/index.js`,
    manifestPath: `/synthetic/${id}/openclaw.plugin.json`,
  })),
};
const candidates: PluginAutoEnableCandidate[] = [
  ...channels.map((id) => ({ pluginId: id, kind: "channel-configured" as const, channelId: id })),
  { pluginId: "openai", kind: "provider-model-configured", modelRef: "openai/fixture-model" },
  { pluginId: "team-reports", kind: "setup-auto-enable", reason: "synthetic configured plugin" },
];
if (values.flow === "frozen" || values.flow === "rewrite") {
  freezeJsonSnapshot(config);
} else if (values.flow === "published") {
  prepareRuntimePluginsConfig(config);
}
const params = { config, candidates, manifestRegistry, env: {} };
let result = owner.materializePluginAutoEnableCandidatesInternal(params);
function run(count: number): void {
  for (let iteration = 0; iteration < count; iteration++) {
    result = owner.materializePluginAutoEnableCandidatesInternal(params);
  }
}
run(100);
globalThis.gc();
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const cpuBefore = process.cpuUsage();
const threadBefore = process.threadCpuUsage();
const start = performance.now();
run(iterations);
const wallMs = performance.now() - start;
const threadCpu = process.threadCpuUsage(threadBefore);
const cpu = process.cpuUsage(cpuBefore);
let sampledBytes: number | undefined;
let samples: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  samples = profile.samples.length;
  inspector.disconnect();
}
assert.equal(result.config.plugins?.entries?.["team-reports"]?.enabled, false);
assert.equal(result.config.plugins?.entries?.clickclack?.enabled, true);
assert.deepEqual(result.config.plugins?.allow, ids);
assert.equal(result.changes.length, values.flow === "rewrite" ? 1 : 0);
assert.equal(result.config === config, values.flow !== "rewrite");
assert.equal(
  config.plugins?.entries?.clickclack?.enabled,
  values.flow === "rewrite" ? undefined : true,
);
console.log(
  JSON.stringify({
    ownerSha256: hash("sha256", readFileSync(modulePath)),
    node: process.version,
    flow: values.flow,
    mode: values.allocation ? "allocation" : "timing",
    entries: ids.length,
    candidates: candidates.length,
    iterations,
    wallMs,
    wallUsPerCall: (wallMs * 1000) / iterations,
    processCpuUsPerCall: (cpu.user + cpu.system) / iterations,
    mainThreadCpuUsPerCall: (threadCpu.user + threadCpu.system) / iterations,
    sampledBytes,
    sampledBytesPerCall: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    samples,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  }),
);
