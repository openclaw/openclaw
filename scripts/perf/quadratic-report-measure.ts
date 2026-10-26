/**
 * Whole-owner report benchmark; synthetic state, no provider calls or Gateway.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/quadratic-report-measure.ts \
 *   --case prompt --mode timing --iterations 2000
 * Use --case plugins for 40 decision providers; prompt uses 400 tools from 40 plugins.
 * Repeat alternating revisions, then use --mode allocation for a separate sampled pass.
 * --owner /absolute/path/to/owner.ts selects an alternate owner module (same export contract).
 * Allocation sampling includes collected objects. Sampled CPU/GC are context only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { buildSystemPromptReport } from "../../src/agents/system-prompt-report.js";
import type { ToolSearchCatalogEntry } from "../../src/agents/tool-search-types.js";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import type { buildAllPluginInspectReports } from "../../src/plugins/status.js";

const { values } = parseArgs({
  options: {
    case: { type: "string", default: "prompt" },
    mode: { type: "string", default: "timing" },
    owner: { type: "string" },
    iterations: { type: "string", default: "2000" },
  },
});
assert(values.case === "prompt" || values.case === "plugins", "--case prompt|plugins");
assert(values.mode === "timing" || values.mode === "allocation", "--mode timing|allocation");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
assert(!values.owner || path.isAbsolute(values.owner), "--owner must be an absolute module path");
const localDir = path.resolve(".local");
await mkdir(localDir, { recursive: true });
const stateDir = await mkdtemp(path.join(localDir, "quadratic-report-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");

try {
  let run: () => unknown;
  const ownerUrl = values.owner && pathToFileURL(values.owner).href;
  if (values.case === "prompt") {
    const owner: { buildSystemPromptReport: typeof buildSystemPromptReport } = await import(
      ownerUrl ?? "../../src/agents/system-prompt-report.js"
    );
    const { Type } = await import("typebox");
    const parameters = Type.Object({ query: Type.String() });
    const tools: AnyAgentTool[] = Array.from({ length: 400 }, (_, index) => ({
      name: `fixture_tool_${index}`,
      label: `Fixture tool ${index}`,
      description: `Search synthetic collection ${index}`,
      parameters,
      execute: async () => ({ content: [], details: {} }),
    }));
    const catalogEntries: ToolSearchCatalogEntry[] = tools.map((tool, index) => ({
      id: `fixture-${Math.floor(index / 10)}:${tool.name}`,
      name: tool.name,
      description: tool.description,
      parameters,
      source: "mcp",
      sourceName: `fixture-${Math.floor(index / 10)}`,
      directVisible: true,
      tool,
    }));
    const input: Parameters<typeof buildSystemPromptReport>[0] = {
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "Synthetic benchmark system prompt.",
      injectedWorkspaceFiles: [],
      skillsPrompt: "",
      tools,
      catalogEntries,
    };
    run = () => owner.buildSystemPromptReport(input);
  } else {
    const [owner, { DecisionProviderHost }, { createEmptyPluginRegistry }, { createPluginRecord }] =
      await Promise.all([
        import(ownerUrl ?? "../../src/plugins/status.js") as Promise<{
          buildAllPluginInspectReports: typeof buildAllPluginInspectReports;
        }>,
        import("../../src/decisions/provider-host.js"),
        import("../../src/plugins/registry-empty.js"),
        import("../../src/plugins/status.test-helpers.js"),
      ]);
    const report = createEmptyPluginRegistry();
    report.plugins = Array.from({ length: 40 }, (_, index) =>
      createPluginRecord({ id: `fixture-${index}`, source: `/synthetic/${index}.ts` }),
    );
    report.decisionProviders = report.plugins.map((plugin) => ({
      pluginId: plugin.id,
      host: new DecisionProviderHost(
        {
          id: plugin.id,
          contractVersion: 1,
          async evaluate() {
            throw new Error("Inspection must not evaluate decisions");
          },
        },
        plugin,
      ),
    }));
    const input: Parameters<typeof buildAllPluginInspectReports>[0] = {
      config: { agents: { defaults: { decisionModel: "fixture-0/model" } } },
      workspaceDir: stateDir,
      report,
    };
    run = () => owner.buildAllPluginInspectReports(input);
  }
  for (let index = 0; index < 200; index++) {
    run();
  }
  global.gc?.();
  await nextTurn();
  const inspector = new Session();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const collections: { kind: number; ms: number }[] = [];
  let start = Infinity;
  let end = Infinity;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime >= start && entry.startTime < end) {
        collections.push({
          kind: (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind,
          ms: entry.duration,
        });
      }
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpuStart = process.cpuUsage();
  start = performance.now();
  let output: unknown;
  for (let index = 0; index < iterations; index++) {
    output = run();
  }
  end = performance.now();
  const cpu = process.cpuUsage(cpuStart);
  const memoryAfter = process.memoryUsage();
  const hostLoadAfter = loadavg();
  let allocatedBytes: number | null = null;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
  }
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  const gcByKind: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
  for (const collection of collections) {
    const group = (gcByKind[collection.kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
    group.count++;
    group.totalMs += collection.ms;
    group.maxMs = Math.max(group.maxMs, collection.ms);
  }
  console.log(
    JSON.stringify({
      case: values.case,
      mode: values.mode,
      owner: ownerUrl ?? "current",
      iterations,
      cpuMs: (cpu.user + cpu.system) / 1000,
      wallMs: end - start,
      allocatedBytes,
      allocatedBytesPerCall: allocatedBytes === null ? null : allocatedBytes / iterations,
      gc: {
        count: collections.length,
        totalMs: collections.reduce((total, item) => total + item.ms, 0),
        maxMs: collections.reduce((max, item) => Math.max(max, item.ms), 0),
        byKind: gcByKind,
      },
      memoryBefore,
      memoryAfter,
      hostLoadBefore,
      hostLoadAfter,
      // Host generation IDs and the isolated workspace path vary between processes.
      outputDigest: createHash("sha256")
        .update(
          JSON.stringify(output, (key, value: unknown) =>
            key === "runtimeGeneration" || key === "workspaceDir" ? "<isolated>" : value,
          ),
        )
        .digest("hex"),
    }),
  );
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
