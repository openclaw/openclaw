/**
 * Measure MCP projection -> transcript snapshot -> guest consumption -> namespace return.
 * Uses 40 synthetic servers with eight tools each and a 64-row structured result.
 * Save code-mode-namespaces.ts beside itself as .code-mode-namespaces-baseline.ts
 * before editing; use --owner src/agents/.code-mode-namespaces-baseline.ts for base.
 * Run base/candidate in alternating AB/BA order, timing and allocation separately:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/mcp-namespace-result-measure.ts
 *   [--owner <path>] [--iterations 3000] [--allocations]
 * Remove the saved baseline afterward. This is owner cost, not Gateway throughput.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  consumeMcpCodeModeGuestResult,
  projectMcpCallToolResult,
} from "../../src/agents/mcp-content.js";
import { snapshotToolSearchTargetTranscriptResult } from "../../src/agents/tool-search-transcript.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/agents/code-mode-namespaces.ts" },
    iterations: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const { createCodeModeNamespaceRuntime } = (await import(
  pathToFileURL(path.resolve(values.owner)).href
)) as typeof import("../../src/agents/code-mode-namespaces.js");
const runtime = createCodeModeNamespaceRuntime(
  Array.from({ length: 320 }, (_, index) => {
    const serverName = `server${Math.floor(index / 8)}`;
    const toolName = `read${index % 8}`;
    return {
      id: `mcp:${serverName}:${toolName}`,
      name: `${serverName}__${toolName}`,
      source: "mcp",
      parameters: { type: "object", properties: {} },
      mcp: { serverName, safeServerName: serverName, toolName, operation: "tool" as const },
    };
  }),
);
const source = {
  content: [{ type: "text", text: "Synthetic repository search results" }],
  structuredContent: {
    rows: Array.from({ length: 64 }, (_, index) => ({
      id: index,
      path: `docs/project-${index}/README.md`,
      description: "Synthetic search result with Unicode 名称. ".repeat(4),
      labels: ["documentation", "reviewed"],
      score: index / 64,
    })),
    nextCursor: null,
  },
};
let transcript: unknown;
const execute = async () => {
  const snapshot = snapshotToolSearchTargetTranscriptResult(projectMcpCallToolResult(source));
  transcript = snapshot;
  return consumeMcpCodeModeGuestResult(snapshot);
};
const invoke = (index: number) =>
  runtime.invoke(
    "mcp",
    [`server${Math.floor((index % 320) / 8)}`, `read${index % 8}`],
    [{}],
    execute,
  );
for (let index = 0; index < 100; index++) {
  await invoke(index);
}
global.gc?.();
const session = new inspector.Session();
if (values.allocations) {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.cpuUsage();
const started = performance.now();
let guest: unknown;
for (let index = 0; index < iterations; index++) {
  guest = await invoke(index);
}
const wallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
let sampledBytes: number | undefined;
if (values.allocations) {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  session.disconnect();
}
assert.deepEqual(guest, source);
console.log(
  JSON.stringify({
    owner: values.owner,
    iterations,
    hostLoad,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    transcriptSha256: createHash("sha256").update(JSON.stringify(transcript)).digest("hex"),
    guestSha256: createHash("sha256").update(JSON.stringify(guest)).digest("hex"),
    ...process.memoryUsage(),
  }),
);
