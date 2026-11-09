/**
 * Warm models.list projection over the checkout's bundled/provider manifest catalog.
 * Run unchanged on base and candidate, alternating launch order:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/models-list-read-measure.ts \
 *   --iterations 100 --warmup 20
 * Repeat with --iterations 2000, then --allocations for a separate sampled-allocation pass.
 * --profile writes the allocation profile to that path; timings with tracing are diagnostic.
 * Preparation, manifest loading, and response serialization are outside the measured loop.
 * Synthetic API-key profiles exercise the real prepared reader, without provider requests.
 * This is the catalog owner's warm read, not RPC/serialization or whole-Gateway throughput.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AuthProfileStore } from "../../src/agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { BuildModelsListResultParams } from "../../src/gateway/server-methods/models-list-context.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "100" },
    warmup: { type: "string", default: "20" },
    allocations: { type: "boolean", default: false },
    profile: { type: "string" },
    view: { type: "string", default: "all" },
  },
});
const count = (name: "iterations" | "warmup") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = count("iterations");
const warmup = count("warmup");
const view = values.view;
assert(view === "all" || view === "configured", "--view must be all or configured");
assert(!values.profile || values.allocations, "--profile requires --allocations");
assert(global.gc, "Run with --expose-gc");
const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(path.join(root, ".local"), { recursive: true });
const stateDir = await mkdtemp(path.join(root, ".local/models-list-measure-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
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
  // Import after selecting isolated state; no operator configuration or account files are read.
  const { loadPluginManifest } = await import("../../src/plugins/manifest.js");
  const { createPluginMetadataSnapshotFixture } =
    await import("../../src/plugins/plugin-metadata.test-support.js");
  const { loadManifestModelCatalog } = await import("../../src/agents/model-catalog.js");
  const { markPreparedModelCatalogFull } =
    await import("../../src/agents/prepared-model-runtime.full-catalog.js");
  const { prepareModelsListResult } =
    await import("../../src/gateway/server-methods/models-list-result.js");
  const plugins = [];
  for (const entry of (
    await readdir(path.join(root, "extensions"), { withFileTypes: true })
  ).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const rootDir = path.join(root, "extensions", entry.name);
    const loaded = loadPluginManifest(rootDir);
    if (loaded.ok && loaded.manifest.modelCatalog) {
      plugins.push({ ...loaded.manifest, rootDir });
    }
  }
  assert(plugins.length > 0, "Checkout has no provider manifests");
  const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins });
  const config: OpenClawConfig = {
    agents: {
      defaults: { workspace: stateDir, modelPolicy: { allow: ["*"] } },
      entries: { main: { agentDir: path.join(stateDir, "agent") } },
    },
    plugins: { entries: Object.fromEntries(plugins.map(({ id }) => [id, { enabled: true }])) },
    models: { catalogRefresh: { enabled: false } },
  };
  const entries = loadManifestModelCatalog({ config, metadataSnapshot });
  const providers = [...new Set(entries.map((entry) => entry.provider))];
  assert(entries.length > 100, "Bundled fixture must contain a realistic catalog");
  const authStore: AuthProfileStore = {
    version: 1,
    profiles: Object.fromEntries(
      providers.map((provider) => [
        `${provider}:fixture`,
        { type: "api_key" as const, provider, key: "synthetic-benchmark-key" },
      ]),
    ),
  };
  const modelCatalog = markPreparedModelCatalogFull({ entries, routeVariants: entries });
  const request: BuildModelsListResultParams = {
    source: {
      kind: "published",
      owner: {
        catalogOwner: { agentId: "main", workspaceDir: stateDir },
        agentId: "main",
        agentDir: path.join(stateDir, "agent"),
        workspaceDir: stateDir,
        config,
        observationConfig: config,
        authModes: {},
        authStore,
        authMaterializations: [],
        metadataSnapshot,
        modelCatalog,
        isCurrent: () => true,
      },
    },
    agentId: "main",
    params: { view, includeDetails: true, includeDefaultModels: false, preparedOnly: true },
    preloadedOnly: true,
    includeManualSelection: true,
  };
  const prepared = await prepareModelsListResult(request);
  assert(prepared.isCurrent());
  const reference = JSON.stringify(prepared.read());
  const responseHash = createHash("sha256").update(reference).digest("hex");
  let checksum = 0;
  const read = () => {
    const result = prepared.read();
    checksum += result.models.length;
    return result;
  };
  for (let index = 0; index < warmup; index++) {
    read();
  }
  global.gc();
  await nextTurn();
  observer.observe({ entryTypes: ["gc"] });
  const hostLoadStart = loadavg();
  const memoryStart = process.memoryUsage();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const samples: number[] = [];
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    read();
    samples.push(performance.now() - before);
  }
  const ended = performance.now();
  const elapsedMs = ended - started;
  const cpu = process.threadCpuUsage(cpuStart);
  const memoryEnd = process.memoryUsage();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  const measuredGc = collections.filter(({ start }) => start >= started && start < ended);
  const gcMs = measuredGc.reduce((total, entry) => total + entry.duration, 0);
  const gcByKind = Object.fromEntries(
    [...new Set(measuredGc.map(({ kind }) => kind))].map((kind) => {
      const events = measuredGc.filter((entry) => entry.kind === kind);
      return [
        kind,
        {
          count: events.length,
          totalMs: events.reduce((total, entry) => total + entry.duration, 0),
          maxMs: Math.max(...events.map(({ duration }) => duration)),
        },
      ];
    }),
  );
  assert(prepared.isCurrent());
  assert.equal(JSON.stringify(prepared.read()), reference, "Warm reads changed response bytes");
  if (profile && values.profile) {
    await writeFile(values.profile, JSON.stringify(profile));
  }
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
  const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
  console.log(
    JSON.stringify({
      mode: values.allocations ? "allocation" : "timing",
      view,
      iterations,
      warmup,
      node: process.version,
      pluginCount: plugins.length,
      providerCount: providers.length,
      inputModelCount: entries.length,
      outputModelCount: prepared.read().models.length,
      responseBytes: Buffer.byteLength(reference),
      responseHash,
      checksum,
      elapsedMs,
      msPerCall: elapsedMs / iterations,
      mainThreadCpuMsPerCall: (cpu.user + cpu.system) / 1000 / iterations,
      allocatedBytesPerCall: profile ? allocated(profile.head) / iterations : undefined,
      gcMs,
      gcMsPerCall: gcMs / iterations,
      gcMaxMs: Math.max(0, ...measuredGc.map(({ duration }) => duration)),
      gcByKind,
      latencySamples: samples.length,
      medianMs: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      memoryStart,
      memoryEnd,
      hostLoadStart,
      hostLoadEnd: loadavg(),
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
  await rm(stateDir, { recursive: true, force: true });
}
