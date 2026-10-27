// Owner workload: node --import ./scripts/tsx.mjs scripts/perf/startup-model-scope-measure.ts
// Copy this script to the base checkout and add --baseline for its previous owner signature.
// --owner-module <path> can select a saved owner module with its imports resolved to that revision.
// Run timing and --allocations separately; --iterations 4000 --warmup 200 --output <file>.
// Includes the real caller prepass and auth preparation; all inputs are synthetic and env-only.
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { withAgentRosterFactsBatch } from "../../src/agents/agent-scope-config.ts";
import { authProfileRuntimeMode } from "../../src/agents/auth-profiles/runtime-scope.ts";
import { parseConfiguredModelVisibilityEntries } from "../../src/agents/model-selection-shared.ts";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectPreparedModelRuntimeProviderIds,
} from "../../src/agents/prepared-model-runtime.configured.ts";
import type { PreparedModelRuntimeInput } from "../../src/agents/prepared-model-runtime.types.ts";
import { captureRuntimeConfig } from "../../src/config/runtime-source-projection.ts";

const { values } = parseArgs({
  options: {
    baseline: { type: "boolean" },
    allocations: { type: "boolean" },
    iterations: { type: "string", default: "4000" },
    warmup: { type: "string", default: "200" },
    output: { type: "string" },
    "owner-module": { type: "string" },
  },
});
const {
  prepareAgentFacts,
}: typeof import("../../src/agents/prepared-model-runtime.agent-facts.ts") = await import(
  values["owner-module"]
    ? pathToFileURL(path.resolve(values["owner-module"])).href
    : "../../src/agents/prepared-model-runtime.agent-facts.ts"
);
const iterations = Number(values.iterations);
const warmup = Number(values.warmup);
if (
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  !Number.isSafeInteger(warmup) ||
  warmup < 0
) {
  throw new Error("iterations must be positive and warmup nonnegative integers");
}
const modelRef = (index: number) => `fixture-${index % 4}/model-${index}`;
const config = captureRuntimeConfig({
  agents: {
    defaults: {
      model: modelRef(0),
      models: Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [modelRef(i), { alias: `alias-${i}` }]),
      ),
      modelPolicy: { allow: ["fixture-0/*", "fixture-1/*"] },
    },
    entries: Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `agent-${i}`,
        {
          model: {
            primary: modelRef(i),
            fallbacks: Array.from({ length: 30 }, (_model, j) => modelRef(j + 32)),
          },
        },
      ]),
    ),
  },
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`fixture-plugin-${i}`, { enabled: true }]),
    ),
  },
});
const inputs: PreparedModelRuntimeInput[] = Array.from({ length: 8 }, (_, i) => ({
  config,
  agentId: `agent-${i}`,
  agentDir: path.resolve(`.local/startup-model-scope-measure/agent-${i}`),
  env: {},
  skipCredentials: true,
}));
const assertCurrent = () => {};
async function prepare(input: PreparedModelRuntimeInput) {
  const scope = withAgentRosterFactsBatch(config, () => {
    const configuredModelRefs = collectPreparedModelRuntimeConfiguredRefs(config, input.agentId);
    const providerIds = [
      ...collectPreparedModelRuntimeProviderIds(
        config,
        {},
        false,
        configuredModelRefs,
        input.agentId,
      ),
      ...parseConfiguredModelVisibilityEntries({ cfg: config, agentId: input.agentId })
        .providerWildcards,
    ];
    return { configuredModelRefs, providerIds };
  });
  const facts: Awaited<ReturnType<typeof prepareAgentFacts>> = values.baseline
    ? await Reflect.apply(prepareAgentFacts, undefined, [
        input,
        "static",
        {},
        assertCurrent,
        [],
        false,
      ])
    : await prepareAgentFacts(input, {}, scope, assertCurrent, false);
  return facts.configuredModelRefs.length + facts.providerIds.length;
}
const inspector = values.allocations ? new Session() : undefined;
const collections: PerformanceEntry[] = [];
const observer = new PerformanceObserver((events) => collections.push(...events.getEntries()));
observer.observe({ entryTypes: ["gc"] });
try {
  const result = await authProfileRuntimeMode.run({ kind: "env-only" }, async () => {
    for (let i = 0; i < warmup; i++) {
      await prepare(inputs[i % inputs.length]!);
    }
    await nextTurn();
    inspector?.connect();
    await inspector?.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const hostLoadBefore = loadavg();
    const started = performance.now();
    const cpu = process.threadCpuUsage();
    let checksum = 0;
    for (let i = 0; i < iterations; i++) {
      checksum += await prepare(inputs[i % inputs.length]!);
    }
    const used = process.threadCpuUsage(cpu);
    const ended = performance.now();
    const memory = process.memoryUsage();
    const sampled = await inspector?.post("HeapProfiler.stopSampling");
    await nextTurn();
    collections.push(...observer.takeRecords());
    const gc = collections.filter((entry) => entry.startTime >= started && entry.startTime < ended);
    return {
      revision: values.baseline ? "base" : "candidate",
      mode: inspector ? "allocation-diagnostic" : "untraced-timing",
      agents: inputs.length,
      plugins: 40,
      iterations,
      warmup,
      checksum,
      wallMs: ended - started,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      gc: {
        count: gc.length,
        totalMs: gc.reduce((sum, entry) => sum + entry.duration, 0),
        maxMs: Math.max(0, ...gc.map((entry) => entry.duration)),
      },
      heapUsed: memory.heapUsed,
      rss: memory.rss,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      ...(sampled
        ? { sampledBytes: sampled.profile.samples.reduce((sum, sample) => sum + sample.size, 0) }
        : {}),
    };
  });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    await fs.mkdir(path.dirname(values.output), { recursive: true });
    await fs.writeFile(values.output, json);
  }
  process.stdout.write(json);
} finally {
  observer.disconnect();
  inspector?.disconnect();
}
