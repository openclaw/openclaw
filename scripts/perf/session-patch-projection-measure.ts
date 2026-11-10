/**
 * Session patch projection owner benchmark (not Gateway throughput):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-patch-projection-measure.ts \
 *   --root /checkout --mode timing --iterations 3000 --samples 5
 * Repeat with --mode allocation, alternating base/candidate launch order. The same
 * script imports each revision's real owner. Allocation includes collected objects;
 * --source selects a saved source beside its original module; --shape selects one workload.
 * traced timing is diagnostic only. Compare outputSha256 before comparing costs.
 * A 10k-row synthetic pool carries large skill snapshots and 40 plugin extensions.
 * Pool entries are deeply frozen; profile-switch copies a row to add its previous pin.
 * Full outputs from 32 evenly spaced rows per shape are
 * hashed outside measurement. Date.now is fixed for byte-identical projections.
 * Explicit model switching supplies a synthetic catalog; no provider is contacted.
 * State is isolated under the invoking checkout's .local and removed on completion.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogSnapshot } from "../../src/agents/model-catalog.types.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: fileURLToPath(new URL("../../", import.meta.url)) },
    source: { type: "string" },
    shape: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    samples: { type: "string", default: "5" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
const integer = (name: "iterations" | "samples") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const samples = integer("samples");
const root = path.resolve(values.root);
const source = path.resolve(values.source ?? path.join(root, "src/gateway/sessions-patch.ts"));
const sourceSha256 = createHash("sha256")
  .update(await readFile(source))
  .digest("hex");
const { projectSessionsPatchEntry }: typeof import("../../src/gateway/sessions-patch.js") =
  await import(pathToFileURL(source).href);
const { withOpenClawTestState }: typeof import("../../src/test-utils/openclaw-test-state.js") =
  await import(pathToFileURL(path.join(root, "src/test-utils/openclaw-test-state.ts")).href);

function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    freeze(child);
  }
  Object.freeze(value);
}

const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "synthetic/fixture-model" },
      models: { "synthetic/fixture-model": { agentRuntime: { id: "openclaw" } } },
    },
  },
};
const switchCfg: OpenClawConfig = {
  agents: {
    defaults: {
      ...cfg.agents?.defaults,
      models: {
        ...cfg.agents?.defaults?.models,
        "synthetic/fixture-switch": { agentRuntime: { id: "openclaw" } },
      },
    },
  },
};
const catalog: ModelCatalogSnapshot = {
  entries: ["fixture-model", "fixture-switch"].map((id) => ({
    id,
    name: id,
    provider: "synthetic",
    api: "openai-responses",
  })),
  routeVariants: [],
};
const extensions = Object.fromEntries(
  Array.from({ length: 40 }, (_, index) => [
    `synthetic-plugin-${index}`,
    { text: "synthetic plugin metadata ".repeat(64), enabled: true },
  ]),
);
const rows = Array.from({ length: 10_000 }, (_, index) => ({
  key: `agent:main:${index % 5 ? "subagent" : "dashboard"}:synthetic-${index}`,
  entry: {
    sessionId: `synthetic-session-${index}`,
    lifecycleRevision: `synthetic-revision-${index}`,
    updatedAt: 1_000,
    label: `Synthetic label ${index}`,
    autoLabel: `Synthetic task ${index}`,
    category: "Synthetic benchmark",
    modelProvider: "synthetic",
    model: "fixture-model",
    providerOverride: "synthetic",
    modelOverride: "fixture-model",
    agentRuntimeOverride: "openclaw",
    markedUnreadAt: 900,
    lastReadAt: 800,
    inputTokens: 2_000,
    outputTokens: 500,
    skillsSnapshot: { prompt: "synthetic skill instructions ".repeat(2_048), skills: [] },
    pluginExtensions: extensions,
    ...(index % 2 ? { archivedAt: 950, archiveReason: "manual" as const } : {}),
  } satisfies SessionEntry,
}));
freeze(cfg);
freeze(switchCfg);
freeze(catalog);
freeze(rows);
const shapes: Array<{
  name: string;
  patch: Partial<SessionsPatchParams>;
  config?: OpenClawConfig;
  loadCatalog?: () => Promise<ModelCatalogSnapshot>;
}> = [
  { name: "read-marker", patch: { unread: false } },
  { name: "label", patch: { label: "Renamed synthetic session" } },
  { name: "model-reset", patch: { model: null } },
  { name: "archive", patch: { archived: true } },
  { name: "unarchive", patch: { archived: false } },
  {
    name: "model-switch",
    patch: { model: "synthetic/fixture-switch" },
    config: switchCfg,
    loadCatalog: async () => catalog,
  },
  {
    name: "profile-switch",
    patch: { model: "synthetic/fixture-switch@synthetic-new" },
    config: switchCfg,
    loadCatalog: async () => catalog,
  },
];
assert(!values.shape || shapes.some((shape) => shape.name === values.shape), "Unknown shape");
const fixedNow = 2_000;
const realNow = Date.now;
const tempRoot = path.resolve(".local/session-patch-projection-measure");
await mkdir(tempRoot, { recursive: true });
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = tempRoot;
try {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: false }, async () => {
    Date.now = () => fixedNow;
    try {
      for (const shape of shapes) {
        if (values.shape && shape.name !== values.shape) {
          continue;
        }
        const project = async (index: number) => {
          const row = rows[index % rows.length]!;
          const result = await projectSessionsPatchEntry({
            cfg: shape.config ?? cfg,
            agentId: "main",
            storeKey: row.key,
            existingEntry:
              shape.name === "profile-switch"
                ? { ...row.entry, authProfileOverride: "synthetic-old" }
                : row.entry,
            patch: { key: row.key, expectedSessionId: row.entry.sessionId, ...shape.patch },
            isLabelInUse: () => false,
            loadGatewayModelCatalogSnapshot: shape.loadCatalog,
          });
          if (!result.ok) {
            throw new Error(`${shape.name}: ${result.error.message}`);
          }
          return result.entry;
        };
        const digest = createHash("sha256");
        for (let index = 0; index < 32; index++) {
          digest.update(JSON.stringify(await project(Math.floor((index * rows.length) / 32))));
        }
        const outputSha256 = digest.digest("hex");
        for (let index = 0; index < Math.min(iterations, 1_000); index++) {
          await project(index);
        }
        for (let sample = 0; sample < samples; sample++) {
          globalThis.gc?.();
          const inspector = values.mode === "allocation" ? new Session() : undefined;
          inspector?.connect();
          await inspector?.post("HeapProfiler.startSampling", {
            samplingInterval: 4_096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          const loadBefore = loadavg();
          const memoryBefore = process.memoryUsage();
          const cpuStart = process.threadCpuUsage();
          const wallStart = performance.now();
          const latencies: number[] = [];
          let checksum = 0;
          for (let index = 0; index < iterations; index++) {
            const started = performance.now();
            const entry = await project(sample * iterations + index);
            latencies.push(performance.now() - started);
            checksum += entry.sessionId.length + entry.updatedAt;
          }
          const wallMs = performance.now() - wallStart;
          const cpu = process.threadCpuUsage(cpuStart);
          const memoryAfter = process.memoryUsage();
          latencies.sort((a, b) => a - b);
          const allocation = await inspector?.post("HeapProfiler.stopSampling");
          inspector?.disconnect();
          const leaves: Array<{ frame: string; bytes: number }> = [];
          const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number => {
            if (node.selfSize) {
              const frame = node.callFrame;
              leaves.push({
                frame: `${frame.functionName || "(anonymous)"}@${frame.url}:${frame.lineNumber + 1}`,
                bytes: node.selfSize,
              });
            }
            return (
              node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0)
            );
          };
          const allocatedBytes = allocation && allocated(allocation.profile.head);
          console.log(
            JSON.stringify({
              root,
              sourceSha256,
              mode: values.mode,
              shape: shape.name,
              sample,
              fixtureSessions: rows.length,
              fixturePlugins: 40,
              iterations,
              checksum,
              outputSha256,
              wallMs,
              latencySamples: latencies.length,
              latencyP50Ms: latencies[Math.floor(latencies.length * 0.5)],
              latencyP95Ms: latencies[Math.floor(latencies.length * 0.95)],
              mainThreadCpuMs: (cpu.user + cpu.system) / 1_000,
              mainThreadCpuUsPerPatch: (cpu.user + cpu.system) / iterations,
              allocatedBytes,
              bytesPerPatch: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
              heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
              rssBefore: memoryBefore.rss,
              rssAfter: memoryAfter.rss,
              loadBefore,
              loadAfter: loadavg(),
              ...(allocation
                ? { sampledLeafFrames: leaves.toSorted((a, b) => b.bytes - a.bytes).slice(0, 20) }
                : {}),
            }),
          );
        }
      }
    } finally {
      Date.now = realNow;
    }
  });
} finally {
  if (previousTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmpdir;
  }
}
