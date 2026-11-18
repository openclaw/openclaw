/**
 * Measure the real sessions.patch response owner, not Gateway throughput:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-patch-response-measure.ts \
 *   --source src/gateway/session-utils-model.ts --mode timing --iterations 3000 --samples 5
 * Repeat with --mode allocation and alternate baseline/candidate process order.
 * Run --shape catalog-control separately, with the same --warmup for both revisions;
 * a preceding metadata workload would warm thinking resolution only on the baseline.
 * A baseline source copy must remain beside its original module so imports resolve.
 * Timing is untraced; allocation sampling includes objects collected during the run.
 * Compare outputSha256 before costs: it hashes complete results for 32 evenly spaced
 * fixture rows outside measurement, including ordinary, ACP, and locked runtimes.
 * Both shapes use 10k frozen synthetic entries carrying 40 plugin metadata fields.
 * The catalog-present control retains thinking/context projection. No provider is
 * contacted; test state is isolated beneath this checkout's .local and cleaned up.
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
import type { ModelCatalogEntry } from "../../src/agents/model-catalog.types.js";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    source: {
      type: "string",
      default: fileURLToPath(new URL("../../src/gateway/session-utils-model.ts", import.meta.url)),
    },
    mode: { type: "string", default: "timing" },
    shape: { type: "string", default: "metadata-response" },
    warmup: { type: "string", default: "1000" },
    iterations: { type: "string", default: "3000" },
    samples: { type: "string", default: "5" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(values.shape === "metadata-response" || values.shape === "catalog-control");
const integer = (name: "iterations" | "samples" | "warmup") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const samples = integer("samples");
const warmup = integer("warmup");
const withCatalog = values.shape === "catalog-control";
const source = path.resolve(values.source);
const sourceSha256 = createHash("sha256")
  .update(await readFile(source))
  .digest("hex");
const { projectSessionPatchResult }: typeof import("../../src/gateway/session-utils-model.js") =
  await import(pathToFileURL(source).href);

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
      model: "openai/gpt-5.6-sol",
      models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } },
    },
  },
};
const catalog: ModelCatalogEntry[] = [
  {
    provider: "openai",
    id: "gpt-5.6-sol",
    name: "Sol",
    reasoning: true,
    contextWindow: 128_000,
    contextTokens: 96_000,
  },
];
const pluginExtensions = Object.fromEntries(
  Array.from({ length: 40 }, (_, index) => [
    `synthetic-plugin-${index}`,
    { text: "synthetic plugin metadata ".repeat(64), enabled: true },
  ]),
);
const rows = Array.from({ length: 10_000 }, (_, index) => ({
  canonicalKey: `agent:main:${index % 5 ? "subagent" : "dashboard"}:synthetic-${index}`,
  entry: {
    sessionId: `synthetic-session-${index}`,
    lifecycleRevision: `synthetic-revision-${index}`,
    updatedAt: 1_000,
    label: `Synthetic label ${index}`,
    category: "Synthetic benchmark",
    providerOverride: "openai",
    modelOverride: "gpt-5.6-sol",
    modelOverrideRouteResolution: "resolved",
    agentRuntimeOverride: "openclaw",
    thinkingLevel: "high",
    inputTokens: 2_000,
    outputTokens: 500,
    pluginExtensions,
    skillsSnapshot: { prompt: "synthetic skill instructions ".repeat(2_048), skills: [] },
    ...(index % 3 === 2 ? { agentHarnessId: "codex", modelSelectionLocked: true } : {}),
    ...(index % 2 ? { archivedAt: 950, archiveReason: "manual" as const } : {}),
  } satisfies SessionEntry,
  preparedAcpMeta:
    index % 3 === 1
      ? ({
          backend: "acpx",
          agent: "main",
          runtimeSessionName: `synthetic-acp-${index}`,
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1_000,
        } satisfies NonNullable<SessionEntry["acp"]>)
      : null,
}));
freeze(cfg);
freeze(catalog);
freeze(rows);
const tempRoot = path.resolve(".local/session-patch-response-measure");
await mkdir(tempRoot, { recursive: true });
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = tempRoot;
try {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: false }, async () => {
    setRuntimeConfigSnapshot(cfg);
    const project = (index: number) =>
      projectSessionPatchResult({
        ...rows[index % rows.length]!,
        cfg,
        targetAgentId: "main",
        storePath: "/synthetic/agents/main/sessions/sessions.json",
        modelCatalog: withCatalog ? catalog : undefined,
      });
    const digest = createHash("sha256");
    for (let index = 0; index < 32; index++) {
      digest.update(JSON.stringify(project(Math.floor((index * rows.length) / 32))));
    }
    const outputSha256 = digest.digest("hex");
    for (let index = 0; index < warmup; index++) {
      project(index);
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
      let checksum = 0;
      for (let index = 0; index < iterations; index++) {
        const result = project(sample * iterations + index);
        checksum += result.entry.sessionId.length + (result.resolved?.agentRuntime?.id.length ?? 0);
      }
      const wallMs = performance.now() - wallStart;
      const cpu = process.threadCpuUsage(cpuStart);
      const memoryAfter = process.memoryUsage();
      const allocation = await inspector?.post("HeapProfiler.stopSampling");
      inspector?.disconnect();
      const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
        node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
      const allocatedBytes = allocation && allocated(allocation.profile.head);
      console.log(
        JSON.stringify({
          source,
          sourceSha256,
          outputSha256,
          mode: values.mode,
          shape: values.shape,
          warmup,
          sample,
          fixtureSessions: rows.length,
          fixturePlugins: 40,
          iterations,
          checksum,
          wallMs,
          mainThreadCpuMs: (cpu.user + cpu.system) / 1_000,
          mainThreadCpuUsPerResponse: (cpu.user + cpu.system) / iterations,
          allocatedBytes,
          bytesPerResponse: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
          memoryBefore,
          memoryAfter,
          loadBefore,
          loadAfter: loadavg(),
        }),
      );
    }
  });
} finally {
  if (previousTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmpdir;
  }
}
