/**
 * Owner microbenchmark (no Gateway/model calls):
 * node --expose-gc --import ./scripts/tsx.mjs extensions/codex/src/test-support/event-projection.bench.ts
 * Run on each revision with identical Node/fixtures. --iterations 2000 --samples 5 are defaults.
 * CPU is untraced; allocation is a separate V8 sampling pass including collected objects.
 * Acceptance: less work and allocation/CPU, unchanged output; host-load-sensitive timing is context.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { CodexToolProgressProjection } from "../app-server/event-projector-tool-progress.js";
import { CodexToolTranscriptProjection } from "../app-server/event-projector-tool-transcript.js";
import { CodexAppServerEventProjector } from "../app-server/event-projector.js";
import type { CodexThreadItem } from "../app-server/protocol.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    samples: { type: "string", default: "5" },
  },
});
const iterations = Number(values.iterations);
const samples = Number(values.samples);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(globalThis.gc, "Run with --expose-gc");

// Only projection is exercised: no session target, persistence, hooks, or provider transport.
const params = {
  provider: "synthetic",
  modelId: "synthetic",
  model: { api: "openai-responses", provider: "synthetic" },
  runId: "synthetic-run",
  sessionId: "synthetic-session",
  workspaceDir: "/synthetic",
} as EmbeddedRunAttemptParamsV2;
const content = Array.from({ length: 8 }, (_, i) => ({
  type: "output_text",
  text: `${i}: ${"synthetic text ".repeat(300)}`,
}));
const fileItem = {
  id: "patch",
  type: "fileChange",
  status: "completed",
  changes: Array.from({ length: 40 }, (_, i) => ({
    path: `src/synthetic-${i}.ts`,
    kind: { type: "update" },
    diff: "@@ -1 +1 @@\n-old\n+new\n".repeat(40),
  })),
} as CodexThreadItem;
const mcpItem = {
  id: "mcp",
  type: "mcpToolCall",
  status: "completed",
  result: { content: [{ type: "text", text: "synthetic result ".repeat(4000) }] },
} as CodexThreadItem;
const transcript = () =>
  new CodexToolTranscriptProjection(
    params,
    "thread",
    "turn",
    new CodexToolProgressProjection(params),
    () => 0,
  );
const workloads = {
  async rawAssistant() {
    const projector = new CodexAppServerEventProjector(params, "thread", "turn");
    await projector.handleNotification({
      method: "rawResponseItem/completed",
      threadId: "thread",
      turnId: "turn",
      completedTurn: undefined,
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { id: "answer", type: "message", role: "assistant", content },
      },
    });
  },
  fileResult() {
    const owner = transcript();
    owner.recordNativeToolResult(fileItem);
    assert.equal(owner.transcriptMessages.length, 1);
  },
  unrecordedTrajectory() {
    const owner = transcript();
    owner.recordTrajectoryEvent({
      phase: "result",
      item: mcpItem,
      name: "synthetic",
      status: "completed",
    });
  },
};
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
const inspector = new Session();
inspector.connect();
const results = [];
try {
  for (const [name, run] of Object.entries(workloads)) {
    for (let i = 0; i < 100; i++) {
      await run();
    }
    for (let sample = 0; sample < samples; sample++) {
      globalThis.gc();
      const hostLoad = loadavg();
      const cpu = process.cpuUsage();
      const started = performance.now();
      for (let i = 0; i < iterations; i++) {
        await run();
      }
      const wallMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      globalThis.gc();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      for (let i = 0; i < iterations; i++) {
        await run();
      }
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      results.push({
        name,
        sample,
        iterations,
        hostLoad,
        cpuUsPerOp: (used.user + used.system) / iterations,
        wallMsPerOp: wallMs / iterations,
        allocatedBytesPerOp: allocated(profile.head) / iterations,
        memory: process.memoryUsage(),
      });
    }
  }
} finally {
  inspector.disconnect();
}
console.log(JSON.stringify({ node: process.version, results }, null, 2));
