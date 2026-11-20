/**
 * MCP catalog-generation and warm binding probe (64 tools, 20 structured fields each).
 * Run with node --expose-gc --import ./scripts/tsx.mjs <this file> [base|candidate] [timing|allocation] [iterations].
 * For base, pass the pinned original normalizer path as the fourth argument.
 * Interleave five base/candidate runs and an initial base/base control; add --cpu-prof to Node separately.
 * Acceptance: identical model tool bytes, zero warm depth walks, lower warm CPU/allocation,
 * and no first-generation regression. This measures the real catalog/binding owners, not Gateway latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
const [arm = "candidate", mode = "timing", rawIterations = "300", basePath] = process.argv.slice(2);
assert(arm === "base" || arm === "candidate");
assert(mode === "timing" || mode === "allocation");
const ownerUrl = new URL(
  "../../packages/ai/src/providers/agent-tools-parameter-schema.ts",
  import.meta.url,
);
const ownerSource = readFileSync(arm === "base" ? assertBasePath() : ownerUrl);
function assertBasePath() {
  assert(basePath, "base requires a pinned original normalizer path");
  return path.resolve(basePath);
}
if (arm === "base") {
  const original = new URL(
    "../../packages/ai/src/providers/agent-tools-parameter-schema.ts",
    import.meta.url,
  ).href;
  const baseline = pathToFileURL(assertBasePath()).href;
  registerHooks({
    load(url, context, nextLoad) {
      return nextLoad(url === original ? baseline : url, context);
    },
  });
}
const { projectBundleMcpServerCatalog } =
  await import("../../src/agents/agent-bundle-mcp-catalog-projection.ts");
const { buildBundleMcpToolsFromCatalog } =
  await import("../../src/agents/agent-bundle-mcp-materialize.ts");
const { createMcpJsonSchemaValidator } =
  await import("../../src/agents/mcp-json-schema-validator.ts");
const iterations = Number(rawIterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "run with --expose-gc");
const tools = Array.from({ length: 64 }, (_, i) => ({
  name: `probe_${i}`,
  inputSchema: {
    type: "object" as const,
    properties: Object.fromEntries(
      Array.from({ length: 20 }, (_field, j) => [
        `field_${j}`,
        {
          type: "object",
          properties: {
            query: { type: "string", description: "synthetic query" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            filters: { type: "array", items: { type: "string" } },
          },
          required: ["query"],
        },
      ]),
    ),
  },
}));
const project = () =>
  projectBundleMcpServerCatalog({
    serverName: "synthetic",
    safeServerName: "synthetic",
    launchDescription: "synthetic fixture",
    rawServer: { command: "unused" },
    listedTools: structuredClone(tools),
    schemaValidator: createMcpJsonSchemaValidator(),
    denialMap: undefined,
    capabilities: {
      tools: { listChanged: false },
      resources: undefined,
      prompts: undefined,
    },
    serverVersion: undefined,
    serverCapabilities: {},
    connection: { requestTimeoutMs: 1000, supportsParallelToolCalls: true },
  }).catalog;
const cpu = () => process.cpuUsage();
const ms = (start: NodeJS.CpuUsage) => {
  const value = process.cpuUsage(start);
  return (value.user + value.system) / 1000;
};
const inspector = new Session();
inspector.connect();
const values = [];
for (let sample = 0; sample < 5; sample++) {
  global.gc();
  if (mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 8192,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const coldThread = process.threadCpuUsage();
  const coldCpu = cpu();
  const coldStart = performance.now();
  const catalog = project();
  const first = buildBundleMcpToolsFromCatalog({ catalog });
  const coldMs = performance.now() - coldStart;
  const coldCpuMs = ms(coldCpu);
  const coldThreadUsage = process.threadCpuUsage(coldThread);
  const coldThreadCpuMs = (coldThreadUsage.user + coldThreadUsage.system) / 1000;
  const expected = JSON.stringify(first.map(({ name, parameters }) => ({ name, parameters })));
  const coldProfile =
    mode === "allocation" ? (await inspector.post("HeapProfiler.stopSampling")).profile : undefined;
  for (let i = 0; i < 10; i++) {
    buildBundleMcpToolsFromCatalog({ catalog });
  }
  global.gc();
  if (mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 8192,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const warmThread = process.threadCpuUsage();
  const warmCpu = cpu();
  const started = performance.now();
  let last = first;
  for (let i = 0; i < iterations; i++) {
    last = buildBundleMcpToolsFromCatalog({ catalog });
  }
  const wallMs = performance.now() - started;
  const cpuMs = ms(warmCpu);
  const warmThreadUsage = process.threadCpuUsage(warmThread);
  const threadCpuMs = (warmThreadUsage.user + warmThreadUsage.system) / 1000;
  const profile =
    mode === "allocation" ? (await inspector.post("HeapProfiler.stopSampling")).profile : undefined;
  const bytes = (node: NonNullable<typeof profile>["head"]): number =>
    node.selfSize + node.children.reduce((sum, c) => sum + bytes(c), 0);
  assert.equal(
    JSON.stringify(last.map(({ name, parameters }) => ({ name, parameters }))),
    expected,
  );
  values.push({
    coldMs,
    coldCpuMs,
    coldThreadCpuMs,
    threadCpuMs,
    coldAllocation: coldProfile ? bytes(coldProfile.head) : undefined,
    wallMs,
    cpuMs,
    allocation: profile ? bytes(profile.head) : undefined,
    iterations,
    sha256: createHash("sha256").update(expected).digest("hex"),
  });
}
console.log(
  JSON.stringify({
    arm,
    mode,
    ownerSha256: createHash("sha256").update(ownerSource).digest("hex"),
    loadavg: loadavg(),
    values,
  }),
);
inspector.disconnect();
