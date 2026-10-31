/**
 * Codex report owner probe (40 tools, nested synthetic schemas).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/codex-tool-report-measure.ts
 * --iterations 2000 --samples 5; run unchanged on base and candidate.
 * --module <path> selects a baseline owner with the same dependencies.
 * Run five base/candidate pairs, reversing launch order on alternate pairs.
 * CPU passes are untraced; separate allocation passes include collected objects.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import * as current from "../../extensions/codex/src/app-server/attempt-context.js";
import type { CodexDynamicToolSpec } from "../../extensions/codex/src/app-server/protocol.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    samples: { type: "string", default: "5" },
    module: { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 2000,
});
const samples = parseStrictIntegerOption({
  raw: values.samples,
  label: "samples",
  min: 1,
  fallback: 5,
});
const { buildCodexSystemPromptReport }: typeof current = values.module
  ? await import(pathToFileURL(values.module).href)
  : current;
assert.ok(globalThis.gc, "Run with --expose-gc");
const tools: CodexDynamicToolSpec[] = Array.from({ length: 40 }, (_tool, index) => ({
  type: "function",
  name: `synthetic_tool_${index}`,
  description: "Synthetic tool description.",
  inputSchema: publishRuntimeToolInputSchema({
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 12 }, (_field, field) => [
        `field_${field}`,
        {
          type: "object",
          properties: {
            query: { type: "string", description: `Synthetic query ${index}/${field}` },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      ]),
    ),
    additionalProperties: false,
  }).schema,
}));
type Params = Parameters<typeof buildCodexSystemPromptReport>[0];
const params: Params = {
  attempt: {
    sessionId: "synthetic",
    provider: "openai",
    modelId: "synthetic",
  } as Params["attempt"],
  sessionKey: "agent:main:synthetic",
  workspaceDir: "/synthetic",
  developerInstructions: "Synthetic instructions",
  workspaceBootstrapContext: { bootstrapFiles: [], contextFiles: [], promptContextFiles: [] },
  skillsPrompt: "",
  tools,
};
function run() {
  for (let index = 0; index < iterations; index++) {
    const report = buildCodexSystemPromptReport(params);
    assert.equal(report.tools.entries.length, tools.length);
  }
}
function bytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
}
run();
const inspector = new Session();
inspector.connect();
const rows = [];
try {
  for (let sample = 0; sample < samples; sample++) {
    globalThis.gc();
    const hostLoad = loadavg();
    const start = process.cpuUsage();
    const wallStart = performance.now();
    run();
    const cpu = process.cpuUsage(start);
    const wallMs = performance.now() - wallStart;
    globalThis.gc();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run();
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    rows.push({
      sample,
      cpuUsPerReport: (cpu.user + cpu.system) / iterations,
      wallUsPerReport: (wallMs * 1000) / iterations,
      sampledBytesPerReport: bytes(profile.head) / iterations,
      hostLoad,
    });
  }
} finally {
  inspector.disconnect();
}
console.log(
  JSON.stringify(
    { node: process.version, tools: tools.length, iterations, samples, rows },
    null,
    2,
  ),
);
