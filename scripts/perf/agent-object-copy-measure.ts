/**
 * Agent object-copy owner costs; run this unchanged against both revisions:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-object-copy-measure.ts --root /checkout --mode timing --iterations 3000
 * Repeat with --mode allocation in a separate process; alternate base/candidate order.
 * --root defaults to this checkout. Static fixtures and MCP publication are outside
 * measurement; CLI costs include constructing a parser for each synthetic turn.
 * Allocation samples include collected objects. Traced timing is diagnostic only.
 * Compare checksum/outputSha256 before costs. These are owner measurements, not
 * whole-Gateway throughput: 64 tool calls/40 tool names, 64 headers, 40 MCP views.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SessionMcpRuntime } from "../../src/agents/agent-bundle-mcp-types.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: fileURLToPath(new URL("../../", import.meta.url)) },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
const owner = (name: string) => pathToFileURL(path.resolve(values.root, "src/agents", name)).href;
const {
  sanitizeToolCallIdsForCloudCodeAssist: sanitize,
}: typeof import("../../src/agents/tool-call-id.js") = await import(owner("tool-call-id.ts"));
const {
  createCliJsonlStreamingParser: createParser,
}: typeof import("../../src/agents/cli-output-stream.js") = await import(
  owner("cli-output-stream.ts")
);
const {
  applyLocalNoAuthHeaders,
  CUSTOM_LOCAL_AUTH_MARKER,
}: typeof import("../../src/agents/model-auth-markers.js") = await import(
  owner("model-auth-markers.ts")
);
const {
  updateMcpAppModelContext,
  leaseMcpAppModelContextForTurn: lease,
}: typeof import("../../src/agents/mcp-app-model-context.js") = await import(
  owner("mcp-app-model-context.ts")
);

const allowedToolNames = Array.from({ length: 40 }, (_, i) => `synthetic_plugin_${i}`);
const calls = Array.from({ length: 64 }, (_, i) => ({
  type: "toolCall" as const,
  id: i % 2 ? `call_${i}|item:${i}` : `toolu_${i}`,
  name: `synthetic_plugin_${i % allowedToolNames.length}`,
  arguments: { query: `synthetic task ${i}`, limit: 20 },
}));
const messages: AgentMessage[] = [
  {
    role: "assistant",
    content: calls,
    provider: "synthetic",
    model: "synthetic",
    api: "anthropic-messages",
    timestamp: 1,
    stopReason: "toolUse",
    usage: {
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1200,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  },
  ...calls.map((call) => ({
    role: "toolResult" as const,
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text" as const, text: "synthetic result" }],
    isError: false,
    timestamp: 2,
  })),
];
const options = {
  allowedToolNames,
  preserveNativeAnthropicToolUseIds: true,
  duplicateToolCallIdStyle: "openai" as const,
};
const headers = Object.fromEntries(
  Array.from({ length: 61 }, (_, i) => [`x-synthetic-${i}`, `value-${i}`]),
);
Object.assign(headers, {
  Authorization: "synthetic",
  authorization: "synthetic",
  AUTHORIZATION: "synthetic",
});
// The context owner uses only sessionId and optional authority callbacks here;
// this synthetic runtime opens no MCP transports or external resources.
const runtime = { sessionId: "synthetic-owner-measure" } as SessionMcpRuntime;
for (let i = 0; i < 40; i++) {
  updateMcpAppModelContext(
    runtime,
    {},
    {
      content: [
        {
          type: "resource",
          _meta: { "openai/title": `Synthetic view ${i}` },
          resource: {
            uri: `synthetic://view/${i}`,
            text: "synthetic resource ".repeat(32),
            _meta: { private: true },
          },
        },
      ],
    },
  );
}
const cliFrames = [
  [
    {
      type: "result",
      session_id: "synthetic-cli",
      result: "<thinking>Synthetic analysis.</thinking>Visible answer.",
    },
  ],
  [
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Partial answer." },
      },
    },
    {
      type: "result",
      subtype: "success",
      result: "",
      terminal_reason: "hook_stopped",
      stop_reason: "tool_use",
      session_id: "synthetic-cli",
    },
  ],
].map((frames) => frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
const parserOptions = {
  backend: {
    command: "claude",
    output: "jsonl" as const,
    jsonlDialect: "claude-stream-json" as const,
  },
  providerId: "claude-cli",
  onAssistantDelta: () => {},
  onThinkingDelta: () => {},
};
let lastResult: unknown;
const workloads = [
  {
    name: "tool-call-ids",
    run: () => {
      const result = sanitize(messages, "strict", options);
      lastResult = result;
      return result.reduce(
        (sum, message) => sum + (message.role === "toolResult" ? message.toolCallId.length : 0),
        0,
      );
    },
  },
  ...cliFrames.map((frames, index) => ({
    name: index ? "cli-stopped-result" : "cli-reasoning-result",
    run: () => {
      const parser = createParser(parserOptions);
      parser.push(frames);
      parser.finish();
      const result = parser.getOutput();
      lastResult = result;
      return result?.text.length ?? 0;
    },
  })),
  {
    name: "no-auth-headers",
    run: () => {
      const result = applyLocalNoAuthHeaders(
        "openai-completions",
        CUSTOM_LOCAL_AUTH_MARKER,
        headers,
      );
      lastResult = result;
      return result?.Authorization === null ? 1 : 0;
    },
  },
  {
    name: "mcp-resource-projection",
    run: () => {
      const projected = lease({ runtime });
      lastResult = projected?.modelContext;
      projected?.rollback();
      return projected?.modelContext.length ?? 0;
    },
  },
];
const digest = () => createHash("sha256").update(JSON.stringify(lastResult)).digest("hex");
for (const workload of workloads) {
  const expected = workload.run();
  assert(expected > 0, `${workload.name} did not exercise its output`);
  const outputSha256 = digest();
  for (let i = 0; i < iterations; i++) {
    workload.run();
  }
  global.gc?.();
  const inspector = new Session();
  if (values.mode === "allocation") {
    await startCollectedHeapSampling(inspector, 4096);
  }
  const loadBefore = loadavg();
  const cpuStart = process.cpuUsage();
  const threadCpuStart = process.threadCpuUsage();
  const wallStart = performance.now();
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    checksum += workload.run();
  }
  const wallMs = performance.now() - wallStart;
  const threadCpu = process.threadCpuUsage(threadCpuStart);
  const cpu = process.cpuUsage(cpuStart);
  let allocatedBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  assert.equal(checksum, expected * iterations);
  assert.equal(digest(), outputSha256);
  console.log(
    JSON.stringify({
      root: values.root,
      mode: values.mode,
      workload: workload.name,
      iterations,
      warmup: iterations,
      checksum,
      outputSha256,
      wallMs,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      cpuMs: (cpu.user + cpu.system) / 1000,
      mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
      allocatedBytes,
      bytesPerOperation: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      loadBefore,
      loadAfter: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
}
