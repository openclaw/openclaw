/**
 * Selected-route source projection, including the cost of preparing each request.
 * Synthetic Team-shaped config: 40 plugins, 100 agents, 40 providers with 8 models each.
 * Run on base and candidate with the same file, separately for timing and allocation:
 * node --import ./scripts/tsx.mjs scripts/perf/runtime-source-projection-measure.ts timing
 * node --import ./scripts/tsx.mjs scripts/perf/runtime-source-projection-measure.ts allocation
 * Optional arguments: requests (default 500), reads/request (default 6), and base/compare.
 * The base arm uses the exact pre-cache projectModelProviderConfig composition.
 * The compare arm runs five AB/BA pairs; each arm warms with 100 preparations.
 * Allocation includes collected objects; do not interpret profiled CPU as timing evidence.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { projectProviderModelRouteConfig } from "../../src/agents/provider-model-route.js";
import { projectModelProviderConfig } from "../../src/config/model-provider-config.js";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../../src/config/runtime-source-projection.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const mode = process.argv[2] ?? "timing";
const requests = Number(process.argv[3] ?? 500);
const reads = Number(process.argv[4] ?? 6);
const arm = process.argv[5] ?? "candidate";
assert(arm === "base" || arm === "candidate" || arm === "compare");
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(requests) && requests > 0);
assert(Number.isSafeInteger(reads) && reads >= 0);
const route = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
} as const;
const source: OpenClawConfig = {
  gateway: { port: 40991 },
  agents: {
    entries: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `agent-${i}`,
        { workspace: `/synthetic/agent-${i}`, name: `Agent ${i}` },
      ]),
    ),
  },
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `plugin-${i}`,
        {
          enabled: true,
          config: { endpoint: `https://plugin-${i}.example.test`, modes: ["a", "b"] },
        },
      ]),
    ),
  },
  models: {
    providers: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        i === 0 ? "openai" : `provider-${i}`,
        {
          baseUrl: `https://provider-${i}.example.test/v1`,
          models: Array.from({ length: 8 }, (_row, j) => ({
            id: `model-${j}`,
            name: `Model ${j}`,
            reasoning: false,
            input: ["text"] as ["text"],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          })),
        },
      ]),
    ),
  },
};
const runtime: OpenClawConfig = { ...source, gateway: { ...source.gateway, mode: "local" } };
setRuntimeConfigSnapshot(runtime, source);
let checksum = 0;
function request(selectedArm: string) {
  const selected =
    selectedArm === "base"
      ? projectModelProviderConfig(runtime, "openai", {
          auth: "api-key",
          api: route.api,
          baseUrl: route.baseUrl,
        })
      : projectProviderModelRouteConfig({ provider: "openai", config: runtime, route });
  for (let i = 0; i < reads; i++) {
    const authored = projectConfigOntoRuntimeSourceSnapshot(selected);
    checksum += authored.gateway!.port!;
  }
}
const arms =
  arm === "compare"
    ? Array.from({ length: 5 }, (_, pair) =>
        pair % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"],
      ).flat()
    : [arm];
for (const selectedArm of arms) {
  checksum = 0;
  for (let i = 0; i < 100; i++) {
    request(selectedArm);
  }
  const inspector = new Session();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const loadBefore = os.loadavg();
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < requests; i++) {
    request(selectedArm);
  }
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  let sampledBytes: number | undefined;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    inspector.disconnect();
  }
  assert.equal(checksum, (requests + 100) * reads * 40991);
  console.log(
    JSON.stringify({
      mode,
      arm: selectedArm,
      requests,
      reads,
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      bytesPerRequest: sampledBytes === undefined ? undefined : sampledBytes / requests,
      loadBefore,
      loadAfter: os.loadavg(),
      memory: process.memoryUsage(),
    }),
  );
}
