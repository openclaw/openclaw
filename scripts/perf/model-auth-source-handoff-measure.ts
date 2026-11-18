/**
 * Prepared model auth reads: 40 providers x 100 models, two interleaved captured scopes.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/model-auth-source-handoff-measure.ts \
 *   --workload service-tier --iterations 4000 --mode timing
 * Repeat with --workload marker and with --mode allocation (separate from timing/GC).
 * For baseline, git-show the three named owners below into a .local directory and pass
 * --owner-dir <directory>. The shared replacement helper preserves their module URLs;
 * all dependencies remain identical. Alternate base/candidate process launch order.
 * Compare responseHash, CPU/read and sampled bytes/read; reject pairs whose start/end
 * one-minute host load exceeds 40. This is owner work, not whole-Gateway throughput.
 * Fixture preparation, module loading and warmup are outside the measured interval.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ModelAuthAvailabilityEvaluation } from "../../src/agents/model-auth-availability.types.js";
import type { ModelServiceTierObservation } from "../../src/agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig, ModelProviderConfig } from "../../src/config/types.js";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    workload: { type: "string", default: "service-tier" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "4000" },
    "owner-dir": { type: "string" },
  },
});
assert(values.workload === "service-tier" || values.workload === "marker");
assert(values.mode === "timing" || values.mode === "allocation");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 4000,
});
const owners = [
  "model-auth-provider-config.ts",
  "model-auth-availability.ts",
  "prepared-model-runtime.catalog-auth.ts",
].map((name) => {
  const url = new URL(`../../src/agents/${name}`, import.meta.url);
  const source = values["owner-dir"] ? path.resolve(values["owner-dir"], name) : fileURLToPath(url);
  return {
    name,
    hash: createHash("sha256").update(readFileSync(source)).digest("hex"),
    replaced: registerPerfOwnerReplacement(url.href, values["owner-dir"] ? source : undefined),
  };
});
const local = fileURLToPath(new URL("../../.local/", import.meta.url));
await mkdir(local, { recursive: true });
const stateDir = await mkdtemp(path.join(local, "model-auth-source-measure-"));
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_HOME: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
});
const inspector = new Session();
const collections: Array<{ start: number; duration: number; kind: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = "detail" in entry ? entry.detail : undefined;
    if (
      detail &&
      typeof detail === "object" &&
      "kind" in detail &&
      typeof detail.kind === "number"
    ) {
      collections.push({ start: entry.startTime, duration: entry.duration, kind: detail.kind });
    }
  }
});
try {
  const { createModelAuthAvailabilityResolver } =
    await import("../../src/agents/model-auth-availability.js");
  const { createPreparedAccountCatalogAccess } =
    await import("../../src/agents/prepared-model-runtime.catalog-auth.js");
  const { captureRuntimeConfig } = await import("../../src/config/runtime-source-projection.js");
  const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
  const { createPluginMetadataSnapshotFixture } =
    await import("../../src/plugins/plugin-metadata.test-support.js");
  assert(
    !values["owner-dir"] || owners.every(({ replaced }) => replaced()),
    "All baseline owners must be loaded",
  );
  const providers = Array.from({ length: 40 }, (_, index) => `synthetic-${index}`);
  const entries: Record<string, ModelProviderConfig> = Object.fromEntries(
    providers.map((provider) => [
      provider,
      {
        api: "openai-completions" as const,
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: values.workload === "marker" ? "custom-local" : `synthetic-${provider}-key`,
        models: Array.from({ length: 100 }, (_, index) => ({
          id: `model-${index}`,
          name: `Synthetic model ${index}`,
          reasoning: false,
          input: ["text" as const],
          contextWindow: 65536,
          maxTokens: 4096,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    ]),
  );
  const config: OpenClawConfig = { models: { providers: entries } };
  setRuntimeConfigSnapshot(config, structuredClone(config));
  const remote: OpenClawConfig = {
    models: {
      providers: Object.fromEntries(
        Object.entries(entries).map(([provider, entry]) => [
          provider,
          {
            ...entry,
            baseUrl: "https://remote.example/v1",
          },
        ]),
      ),
    },
  };
  const captures = [captureRuntimeConfig(config), captureRuntimeConfig(remote)];
  type ReadResult =
    | ModelAuthAvailabilityEvaluation
    | Pick<ModelServiceTierObservation, "requestedTier" | "responseTier">[];
  const reads = captures.flatMap<() => ReadResult>((cfg, scope) => {
    if (values.workload === "marker") {
      const resolver = createModelAuthAvailabilityResolver({
        cfg,
        authStore: { version: 1, profiles: {} },
        env: {},
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
      });
      return providers.map((provider) => () => {
        const result = resolver.evaluateRuntimeModelAuth(provider, {
          modelId: "model-99",
          runtimeId: "openclaw",
        });
        assert.equal(result.availability, scope === 0 ? true : undefined);
        return result;
      });
    }
    const catalog = createPreparedAccountCatalogAccess(() => true, undefined, cfg);
    return providers.map((provider) => {
      const identityKey = `direct:${provider}`;
      const route = {
        modelId: "model-99",
        runtimeId: "openclaw",
        api: "openai-completions",
        baseUrl: entries[provider]!.baseUrl,
      };
      const tiers = { requestedTier: "priority", responseTier: scope === 0 ? "default" : "flex" };
      assert(
        catalog.prepareServiceTierObserver({
          selectedCredential: { source: "direct", provider, identityKey },
        })({ ...route, ...tiers }),
      );
      return () => catalog.readServiceTierObservations({ identityKey, ...route });
    });
  });
  const reference = JSON.stringify(reads.map((read) => read()));
  const responseHash = createHash("sha256").update(reference).digest("hex");
  for (let index = 0; index < reads.length * 2; index++) {
    reads[index % reads.length]!();
  }
  global.gc();
  await nextTurn();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoadStart = loadavg();
  const memoryStart = process.memoryUsage();
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    const result = reads[index % reads.length]!();
    checksum += Array.isArray(result) ? result.length : Number(result.availability === true);
  }
  const ended = performance.now();
  const cpu = process.threadCpuUsage(cpuStart);
  const memoryEnd = process.memoryUsage();
  const hostLoadEnd = loadavg();
  const profile =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  assert.equal(
    JSON.stringify(reads.map((read) => read())),
    reference,
    "Read results changed during measurement",
  );
  const gc = collections.filter(({ start }) => start >= started && start < ended);
  console.log(
    JSON.stringify({
      workload: values.workload,
      mode: values.mode,
      iterations,
      providers: 40,
      modelsPerProvider: 100,
      scopes: 2,
      owners: owners.map(({ name, hash }) => ({ name, hash })),
      responseHash,
      checksum,
      elapsedMs: ended - started,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      sampledBytes: profile?.samples.reduce((sum, sample) => sum + sample.size, 0),
      gcMs: gc.reduce((sum, entry) => sum + entry.duration, 0),
      gcMaxMs: Math.max(0, ...gc.map(({ duration }) => duration)),
      gcByKind: Object.fromEntries(
        [...new Set(gc.map(({ kind }) => kind))].map((kind) => {
          const events = gc.filter((entry) => entry.kind === kind);
          return [
            kind,
            {
              count: events.length,
              totalMs: events.reduce((sum, event) => sum + event.duration, 0),
              maxMs: Math.max(...events.map(({ duration }) => duration)),
            },
          ];
        }),
      ),
      memoryStart,
      memoryEnd,
      hostLoadStart,
      hostLoadEnd,
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
  await rm(stateDir, { recursive: true, force: true });
}
