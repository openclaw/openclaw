/**
 * Agent schema owner microbenchmark, with 40 synthetic plugins x 25 tools.
 * Each iteration renders one plugin's 25 tools, rotating through the inventory.
 * node --import ./scripts/tsx.mjs scripts/perf/agent-fresh-array-copy-measure.ts \
 *   --workload schema --iterations 3000 --mode timing --owner-dir .local/base
 * Omit --owner-dir for current sources. Run schema and mcp separately, alternate
 * base/candidate timing passes, then allocation passes (instrumentation affects
 * timing). Counts mode supports --expect-copies 0 and fails on the old owners.
 * This measures owner work, not Gateway latency. Only isRecord is fixture-bound;
 * schema rendering, parameter documents and virtual files use exact owner source.
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
import type { McpApiServerDoc } from "../../src/agents/code-mode-mcp-api.js";

const { values } = parseArgs({
  options: {
    "owner-dir": { type: "string" },
    "expect-copies": { type: "string" },
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
    workload: { type: "string", default: "schema" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "iterations must be positive");
assert(["timing", "allocation", "counts"].includes(values.mode), "invalid mode");
assert(["schema", "mcp"].includes(values.workload), "invalid workload");
const expectedCopies =
  values["expect-copies"] === undefined ? undefined : Number(values["expect-copies"]);
assert(
  expectedCopies === undefined ||
    (values.mode === "counts" && Number.isSafeInteger(expectedCopies) && expectedCopies >= 0),
  "expect-copies requires counts mode and a nonnegative integer",
);
const filenames = ["tool-schema-hints.ts", "code-mode-mcp-api.ts"];
const owners = new Map(
  filenames.map((filename) => {
    const url = new URL(`../../src/agents/${filename}`, import.meta.url).href;
    return [
      url,
      readFileSync(
        values["owner-dir"] ? path.join(values["owner-dir"], filename) : new URL(url),
        "utf8",
      ),
    ];
  }),
);
const fixtureUrl = `data:text/javascript,${encodeURIComponent(
  "export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);",
)}`;
const loaded = new Set<string>();
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return context.parentURL && owners.has(context.parentURL)
      ? { url: fixtureUrl, shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    const source = owners.get(url);
    if (source === undefined) {
      return next(url, context);
    }
    loaded.add(url);
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const schema: typeof import("../../src/agents/tool-schema-hints.js") = await import(
  new URL("../../src/agents/tool-schema-hints.ts", import.meta.url).href
);
const mcp: typeof import("../../src/agents/code-mode-mcp-api.js") = await import(
  new URL("../../src/agents/code-mode-mcp-api.ts", import.meta.url).href
);
hooks.deregister();
assert.equal(loaded.size, owners.size, "selected owners were not loaded");

const servers: McpApiServerDoc[] = Array.from({ length: 40 }, (_, plugin) => ({
  identifier: `plugin_${plugin}`,
  serverName: `Synthetic plugin ${plugin}`,
  tools: Array.from({ length: 25 }, (_tool, tool) => ({
    method: `tool_${tool}`,
    path: [`group_${4 - (tool % 5)}`, `tool_${tool}`],
    mcpTool: `tool_${tool}`,
    operation: "tool",
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 32 }, (_field, field) => [
          `field_${String(31 - field).padStart(2, "0")}`,
          { type: field % 2 === 0 ? "string" : ["number", "null"] },
        ]),
      ),
      required: ["field_31", "field_00"],
      additionalProperties: false,
    },
    params: [],
  })),
}));
const freeze = (value: unknown): void => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
};
freeze(servers);
const sourceBefore = JSON.stringify(servers);
let output: unknown;
const run = (count: number) => {
  for (let iteration = 0; iteration < count; iteration++) {
    const server = servers[iteration % servers.length]!;
    output =
      values.workload === "schema"
        ? server.tools.map((tool) => schema.toolSchemaDeclaration(tool.parameters))
        : mcp.createMcpApiVirtualFiles([
            {
              ...server,
              tools: server.tools.map((tool) => ({
                method: tool.method,
                path: tool.path,
                mcpTool: tool.mcpTool,
                operation: tool.operation,
                parameters: tool.parameters,
                params: mcp.buildMcpParamDocs(tool.parameters),
              })),
            },
          ]);
  }
};
run(100);
let copies = 0;
let copiedElements = 0;
const originalSort = Array.prototype.toSorted;
const inspector = new Session();
let allocatedBytes: number | undefined;
const cpuUsage = (previous?: NodeJS.CpuUsage) =>
  typeof process.threadCpuUsage === "function"
    ? process.threadCpuUsage(previous)
    : process.cpuUsage(previous);
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
try {
  if (values.mode === "counts") {
    // oxlint-disable-next-line no-extend-native -- Count copying sorts only during this pass; restore in finally.
    Array.prototype.toSorted = function <T>(this: T[], compare?: (a: T, b: T) => number): T[] {
      copies++;
      copiedElements += this.length;
      return originalSort.call(this, compare);
    };
  }
  const cpu = cpuUsage();
  const started = performance.now();
  run(iterations);
  const wallMs = performance.now() - started;
  const used = cpuUsage(cpu);
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
  }
  assert.equal(JSON.stringify(servers), sourceBefore);
  if (expectedCopies !== undefined) {
    assert.equal(copies / iterations, expectedCopies, "copying sorts per iteration");
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      workload: values.workload,
      iterations,
      plugins: servers.length,
      toolsPerIteration: 25,
      ownerSha256: Object.fromEntries(
        [...owners].map(([url, source]) => [
          path.basename(url),
          createHash("sha256").update(source).digest("hex"),
        ]),
      ),
      outputSha256: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
      wallMs,
      cpuScope: typeof process.threadCpuUsage === "function" ? "main-thread" : "process",
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      ...(values.mode === "counts"
        ? {
            copiesPerIteration: copies / iterations,
            copiedElementsPerIteration: copiedElements / iterations,
          }
        : {}),
      hostLoad: loadavg(),
    }),
  );
} finally {
  // oxlint-disable-next-line no-extend-native -- Restore the native method after copy-count instrumentation.
  Array.prototype.toSorted = originalSort;
  inspector.disconnect();
}
