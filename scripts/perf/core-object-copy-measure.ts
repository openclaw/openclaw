/**
 * Measures real cron/config owners against 10,000 jobs and 40 agent/channel inputs.
 * node --import ./scripts/tsx.mjs scripts/perf/core-object-copy-measure.ts \
 *   --workload cron --iterations 5000 --mode timing --owner-dir .local/base
 * Repeat for config/migration; omit --owner-dir for candidate source. The base
 * directory holds row-codec.ts, run-config.ts and channel-compat-normalization.ts.
 * Run five alternating AB/BA pairs, timing separately from sampled allocation.
 * No Gateway or production data is used; these are owner costs, not RPC latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { CronStoredJob } from "../../src/cron/types.js";

const { values } = parseArgs({
  options: {
    "owner-dir": { type: "string" },
    workload: { type: "string", default: "cron" },
    iterations: { type: "string", default: "5000" },
    mode: { type: "string", default: "timing" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["cron", "config", "migration"].includes(values.workload));
assert(["timing", "allocation"].includes(values.mode));
const ownerPaths = [
  "cron/store/row-codec.ts",
  "cron/isolated-agent/run-config.ts",
  "config/channel-compat-normalization.ts",
];
const sources = new Map(
  ownerPaths.map((file) => {
    const url = new URL(`../../src/${file}`, import.meta.url);
    return [
      url.href,
      readFileSync(
        values["owner-dir"] ? path.join(values["owner-dir"], path.basename(file)) : url,
        "utf8",
      ),
    ];
  }),
);
const loaded = new Set<string>();
const hooks = registerHooks({
  load(url, context, next) {
    const source = sources.get(url);
    if (source === undefined) {
      return next(url, context);
    }
    loaded.add(url);
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const { projectCronJobThroughStorageCodec } = await import("../../src/cron/store/row-codec.js");
const { resolveCronAgentConfig } = await import("../../src/cron/isolated-agent/run-config.js");
const { normalizeLegacyChannelAliases } =
  await import("../../src/config/channel-compat-normalization.js");
hooks.deregister();
assert.equal(loaded.size, sources.size, "all selected owner sources must load");
const jobs: CronStoredJob[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `job-${index}`,
  name: `Synthetic scheduled task ${index}`,
  enabled: true,
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_000_000,
  schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_700_000_000_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: {
    kind: "agentTurn",
    message: "Summarize the synthetic project status",
    toolsAllow: ["read", "exec"],
  },
  delivery: { mode: "none" },
  state: { lastRunStatus: "ok", lastDurationMs: 1200 },
}));
const configs: OpenClawConfig[] = Array.from({ length: 40 }, (_, index) => ({
  agents: {
    defaults: {
      workspace: `/synthetic/workspace-${index}`,
      model: { primary: "mock/model", fallbacks: [] },
      thinkingDefault: "low",
      timeoutSeconds: 300,
      maxConcurrent: 8,
      contextTokens: 32_000,
      bootstrapMaxChars: 20_000,
    },
  },
}));
const channels = configs.map((_, index) => ({
  streaming: { mode: "partial", block: { enabled: true }, preview: { toolProgress: true } },
  accounts: Object.fromEntries(
    Array.from({ length: 4 }, (__, account) => [
      `account-${index}-${account}`,
      { chunkMode: "newline", blockStreamingCoalesce: { minChars: 100 } },
    ]),
  ),
}));
const before = JSON.stringify([jobs, configs, channels]);
let output: unknown;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    output =
      values.workload === "cron"
        ? projectCronJobThroughStorageCodec(jobs[index % jobs.length]!)
        : values.workload === "config"
          ? resolveCronAgentConfig({
              config: configs[index % configs.length]!,
              agentConfigOverride: { name: "worker", workspace: "/synthetic/worker" },
            })
          : normalizeLegacyChannelAliases({
              entry: channels[index % channels.length]!,
              pathPrefix: "channels.synthetic",
              changes: [],
              seedAccountStreamingFromRoot: true,
              resolveStreamingOptions: () => ({ resolvedMode: "partial" }),
            });
  }
}
run(500);
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpu = process.threadCpuUsage();
const started = performance.now();
run(iterations);
const wallMs = performance.now() - started;
const used = process.threadCpuUsage(cpu);
let allocatedBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  inspector.disconnect();
}
assert.equal(JSON.stringify([jobs, configs, channels]), before, "owners must not mutate fixtures");
console.log(
  JSON.stringify({
    workload: values.workload,
    mode: values.mode,
    iterations,
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    allocatedBytes,
    loadavg: loadavg(),
    sourceHash: createHash("sha256")
      .update([...sources.values()].join("\n"))
      .digest("hex"),
    outputHash: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
  }),
);
