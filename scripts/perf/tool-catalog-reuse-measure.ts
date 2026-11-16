/**
 * Production catalog owner, synthetic 109-tool inventory. No Gateway/storage claim.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-catalog-reuse-measure.ts
 *   [--source-dir <frozen-src/agents>] [--mode timing|allocation|retention|retention-churn|scenarios]
 * Alternate five baseline/candidate processes and run unchanged A/A controls.
 * --expect-reuse makes the cross-session regression fail on the original owner.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { transformSync } from "esbuild";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.js";

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "1000" },
    "expect-reuse": { type: "boolean" },
  },
});
assert(["timing", "allocation", "retention", "retention-churn", "scenarios"].includes(values.mode));
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "Run with --expose-gc");
const ownerRoot = new URL("../../src/agents/", import.meta.url);
const sources = new Map<string, string>();
if (values["source-dir"]) {
  for (const file of [
    "tool-search-catalog.ts",
    "tool-search-directory.ts",
    "tool-search-runtime.ts",
    "code-mode.ts",
    "code-mode-execution.ts",
    "code-mode-headless.ts",
  ]) {
    const sourcePath = path.join(values["source-dir"], file);
    assert(existsSync(sourcePath), `Missing frozen owner: ${file}`);
    sources.set(new URL(file, ownerRoot).href, readFileSync(sourcePath, "utf8"));
  }
  registerHooks({
    load(url, context, next) {
      const source = sources.get(url);
      return source === undefined
        ? next(url, context)
        : {
            format: "module",
            source: transformSync(source, { loader: "ts", format: "esm" }).code,
            shortCircuit: true,
          };
    },
  });
}
const { createAgentHarnessToolSurfaceRuntimeCore } =
  await import("../../src/agents/harness/tool-surface-bridge.js");
const { buildCodeModeCatalogPrompt } = await import("../../src/agents/code-mode.js");
const { buildToolSchemaDirectoryPrompt } =
  await import("../../src/agents/tool-search-directory.js");
const { getToolSearchCatalogDescriptors } =
  await import("../../src/agents/tool-search-prepared-catalog.js");
const { ToolSearchRuntime } = await import("../../src/agents/tool-search-runtime.js");
const { resolveToolSearchConfig } = await import("../../src/agents/tool-search-config.js");
const config = { tools: { codeMode: { enabled: true } } };
const schema = (index: number) => ({
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: 10 }, (_, field) => [
      `field${field}`,
      { type: "string", description: `Synthetic field ${index} ${field}` },
    ]),
  ),
});
const schemas = Array.from(
  { length: 109 },
  (_, index) => publishRuntimeToolInputSchema(schema(index)).schema,
);
type Scenario =
  | "interactive"
  | "subagent"
  | "cron"
  | "retry"
  | "bridge"
  | "selection"
  | "ordering"
  | "version";
const executableRefs: WeakRef<object>[] = [];
const descriptorRefs: WeakRef<object>[] = [];
let latestPrompt = "";

function attempt(index: number, scenario: Scenario = "interactive", retain = false) {
  const currentConfig =
    scenario === "selection"
      ? {
          tools: {
            toolSearch: {
              enabled: true,
              mode: "directory" as const,
              exclude: [{ name: "fixture_108" }],
            },
          },
        }
      : config;
  const surface = createAgentHarnessToolSurfaceRuntimeCore({
    config: currentConfig,
    modelToolsEnabled: true,
    preparedToolOverrideAllowlist: [],
    agentId: "synthetic",
    sessionKey:
      scenario === "subagent"
        ? `agent:synthetic:subagent:${index}`
        : `agent:synthetic:session-${index % 1000}`,
    runId: scenario === "retry" ? "retry-run" : `run-${index}`,
    trigger: scenario === "cron" ? "cron" : undefined,
  });
  const payload = { index, marker: "synthetic run closure" };
  const tools = schemas
    .slice(0, scenario === "subagent" ? 54 : 109)
    .map((parameters, toolIndex) => ({
      name: `fixture_${toolIndex}`,
      label: "Fixture",
      description: `Synthetic capability ${toolIndex}${scenario === "version" ? ` revision ${index}` : ""}`,
      parameters: retain ? publishRuntimeToolInputSchema(schema(toolIndex)).schema : parameters,
      execute: async () => ({ content: [], details: payload }),
    })) as AnyAgentTool[];
  const result = surface.compactTools(scenario === "ordering" ? tools.toReversed() : tools);
  const catalogRef = surface.toolSearchCatalogRef!;
  const entries = catalogRef.current!.entries;
  const ctx = { config: currentConfig, catalogRef };
  latestPrompt =
    scenario === "selection"
      ? buildToolSchemaDirectoryPrompt(ctx)
      : buildCodeModeCatalogPrompt(ctx, entries);
  if (retain) {
    executableRefs.push(new WeakRef(entries), new WeakRef(tools[0]!), new WeakRef(payload));
    if (!values["source-dir"]) {
      descriptorRefs.push(new WeakRef(getToolSearchCatalogDescriptors(entries).descriptors));
    }
  }
  const runtime = new ToolSearchRuntime(ctx, resolveToolSearchConfig(currentConfig));
  return {
    miss: Number(!result.catalog.catalogReused),
    count: result.catalog.catalogToolCount,
    execute: () => runtime.callValue("fixture_0", {}),
    close: () => {
      surface.cleanup();
      assert.equal(catalogRef.current, undefined);
    },
  };
}

async function collect() {
  await setImmediate();
  globalThis.gc!();
  await setImmediate();
  globalThis.gc!();
}
function run(count: number, retain = false, scenario: Scenario = "interactive", offset = 0) {
  let misses = 0;
  for (let index = 0; index < count; index++) {
    const current = attempt(index + offset, scenario, retain);
    misses += current.miss;
    current.close();
  }
  return misses;
}
if (values.mode === "scenarios") {
  const rows: Array<{ scenario: Scenario; attempts: number; misses: number; tools: number }> = [];
  for (const scenario of [
    "interactive",
    "interactive",
    "subagent",
    "subagent",
    "cron",
    "retry",
    "bridge",
    "selection",
    "selection",
    "ordering",
    "version",
  ] as const) {
    const index = rows.length;
    const current = attempt(index, scenario);
    assert.deepEqual(await current.execute(), { index, marker: "synthetic run closure" });
    rows.push({ scenario, attempts: 1, misses: current.miss, tools: current.count });
    current.close();
  }
  for (let index = 0; index < 40; index++) {
    attempt(index + 100, "version").close();
  }
  const evicted = attempt(1000);
  assert.equal(evicted.miss, 1, "oldest catalog must be evicted after 40 distinct inputs");
  evicted.close();
  console.log(
    JSON.stringify({
      boundary: "harness tool surface, synthetic entry contexts; not Gateway dispatch",
      rows,
      evictionMiss: evicted.miss,
    }),
  );
  if (values["expect-reuse"]) {
    assert.equal(rows[1]!.misses, 0, "equivalent new-session catalog rebuilt");
  }
} else {
  const coldCpu = process.cpuUsage();
  const coldStart = performance.now();
  const coldAllocation = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
  const coldMisses = run(1);
  const cold = {
    misses: coldMisses,
    wallMs: performance.now() - coldStart,
    cpu: process.cpuUsage(coldCpu),
    allocatedBytes: Reflect.get(getHeapStatistics(), "total_allocated_bytes") - coldAllocation,
  };
  run(100);
  await collect();
  const inspector = new Session();
  if (values.mode === "allocation") {
    await startCollectedHeapSampling(inspector, 16384);
  }
  const retention = values.mode.startsWith("retention");
  if (retention) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024 });
  }
  const before = getHeapStatistics();
  const cpu = process.cpuUsage();
  const start = performance.now();
  let misses = 0;
  if (retention) {
    // Turns yield to the event loop. Keeping every WeakRef target alive in one
    // synchronous job would measure the observer's artificial high-water mark.
    for (let index = 0; index < iterations; index += 100) {
      misses += run(
        Math.min(100, iterations - index),
        true,
        values.mode === "retention-churn" ? "version" : "interactive",
        index,
      );
      await collect();
    }
  } else {
    misses = run(iterations);
  }
  const wallMs = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  const allocatedBytes =
    Reflect.get(getHeapStatistics(), "total_allocated_bytes") -
    Reflect.get(before, "total_allocated_bytes");
  let sampledBytes: number | undefined;
  let allocationSites: Array<{ name: string; bytes: number }> | undefined;
  if (retention) {
    await collect();
  }
  if (values.mode === "allocation" || retention) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = sumSampledHeapBytes(profile.head);
    allocationSites = [];
    const visit = (node: typeof profile.head) => {
      if (node.selfSize) {
        allocationSites!.push({
          name: `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber}`,
          bytes: node.selfSize,
        });
      }
      node.children.forEach(visit);
    };
    visit(profile.head);
    allocationSites.sort((a, b) => b.bytes - a.bytes);
    allocationSites = allocationSites.slice(0, 20);
    inspector.disconnect();
  }
  await collect();
  const executableSurvivors = executableRefs.filter((ref) => ref.deref()).length;
  const retainedDescriptorSets = new Set(descriptorRefs.map((ref) => ref.deref()).filter(Boolean))
    .size;
  assert.equal(executableSurvivors, 0, "completed turns retained executable state");
  if (retention && !values["source-dir"]) {
    assert.equal(
      retainedDescriptorSets,
      values.mode === "retention-churn" ? Math.min(iterations, 32) : 1,
      "retained descriptor catalogs exceeded the stable-input/count bound",
    );
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      cold,
      attempts: iterations,
      sessions: 1000,
      tools: 109,
      misses,
      buildsPerAttempt: misses / iterations,
      wallMs,
      cpuMs: (usage.user + usage.system) / 1000,
      allocatedBytes,
      sampledBytes,
      sampling: retention
        ? "retained after GC"
        : values.mode === "allocation"
          ? "including collected objects"
          : undefined,
      allocationSites,
      postGcHeapDelta: getHeapStatistics().used_heap_size - before.used_heap_size,
      executableSurvivors,
      retainedDescriptorSets,
      promptBytes: Buffer.byteLength(latestPrompt),
      promptSha256: createHash("sha256").update(latestPrompt).digest("hex"),
      hostLoad: loadavg(),
    }),
  );
  if (values["expect-reuse"]) {
    assert.equal(misses, 0, "warm new-session catalogs rebuilt");
  }
}
