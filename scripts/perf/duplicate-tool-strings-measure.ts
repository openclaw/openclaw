/**
 * Synthetic owner composition, not a Gateway or SQLite benchmark.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/duplicate-tool-strings-measure.ts <output-prefix>
 * Run identical fresh-process A/A and alternating baseline/candidate samples.
 * Summarize each heap with scripts/heap-snapshot-diff.mjs --summary --labels <reviewed-labels>.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { getHeapStatistics, writeHeapSnapshot } from "node:v8";
import { convertResponsesToolPayload } from "../../packages/ai/src/providers/openai-responses-tools.ts";
import { getPublishedRuntimeToolInputSchema } from "../../packages/ai/src/providers/tool-schema-json-projection.ts";
import { finalizeAgentTools } from "../../src/agents/agent-tools.finalize.ts";
import type { AnyAgentTool } from "../../src/agents/agent-tools.types.ts";
import {
  prepareSessionToolSurface,
  persistSessionToolSurface,
  retainEmbeddedSessionPromptState,
} from "../../src/agents/embedded-agent-runner/session-prompt-state.ts";
import { SessionManager } from "../../src/agents/sessions/session-manager.ts";
import { compactSubagentRunForMemory } from "../../src/agents/subagents/registry/subagent-registry-memory.ts";
import { buildSubagentRunReadTopology } from "../../src/agents/subagents/registry/subagent-registry-read-topology.ts";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.ts";
import type { AssistantMessage } from "../../src/llm/types.js";

assert(globalThis.gc);
const output = process.argv[2];
assert(output);
const sourceTools: AnyAgentTool[] = Array.from({ length: 100 }, (_, i) => ({
  name: `mcp_fixture_${i}`,
  label: `Fixture tool ${i}`,
  description: `Search synthetic collection ${i}. Return matching records with stable identifiers, pagination, and explicit filter semantics.`,
  parameters: {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 12 }, (_field, j) => [
        `field_${j}`,
        {
          type: "string",
          description: `Synthetic collection ${i} filter ${j}. Supply the exact field value to restrict the matching records returned by this operation.`,
        },
      ]),
    ),
    required: ["field_0"],
    additionalProperties: false,
  },
  execute: async () => ({ content: [], details: {} }),
}));
const managers: SessionManager[] = [];
const leases: ReturnType<typeof retainEmbeddedSessionPromptState>[] = [];
const toolsets: {
  prepared: AnyAgentTool[];
  payload: ReturnType<typeof convertResponsesToolPayload>;
}[] = [];
const runRows = new Map<string, SubagentRunRecord>();
let canonical: AnyAgentTool["parameters"][] = [];
let warmSchemaMisses = 0;
const payloadHashes = new Set<string>();
const measurements: { cpuUs: number; wallMs: number; allocatedBytes: number }[] = [];
const allocationStart = getHeapStatistics().total_allocated_bytes;
const started = performance.now();
const cpuStart = process.threadCpuUsage();
for (let session = 0; session < 24; session++) {
  const sessionId = `fixture-session-${session}`;
  const runId = `fixture-run-${session}-00000000-0000-4000-8000-000000000000`;
  const manager = SessionManager.inMemory("/synthetic/workspace");
  managers.push(manager);
  const lease = retainEmbeddedSessionPromptState(sessionId);
  leases.push(lease);
  for (let turn = 0; turn < 200; turn++) {
    await manager.appendMessageAsync({
      role: "user",
      content: [
        {
          type: "text",
          text: `Session ${session}, turn ${turn}. ${"Synthetic transcript text. ".repeat(20)}`,
        },
      ],
      timestamp: turn * 2,
    });
    const reply: AssistantMessage & { __openclaw: { runId: string } } = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Reply ${session}, turn ${turn}. ${"Synthetic response text. ".repeat(20)}`,
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "synthetic",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: turn * 2 + 1,
      __openclaw: { runId },
    };
    await manager.appendMessageAsync(reply);
  }
  for (let run = 0; run < 3; run++) {
    const before = getHeapStatistics().total_allocated_bytes;
    const cpu = process.threadCpuUsage();
    const time = performance.now();
    const cleanups: Array<(reason: string) => Promise<void>> = [];
    const finalized = finalizeAgentTools({
      registerRunCleanup: (cleanup) => cleanups.push(cleanup),
      tools: sourceTools.map((tool) => Object.assign({}, tool)),
      modelProvider: "openai",
      modelId: "synthetic",
      modelApi: "openai-responses",
      hookContext: { sessionKey: `agent:main:${sessionId}`, runId },
      wrapBeforeToolCallHook: false,
    });
    const prepared = prepareSessionToolSurface({
      state: lease.state,
      routeKey: "fixture-route",
      toolPolicy: "fixture-policy",
      entries: manager.getEntries(),
      tools: finalized,
    });
    await persistSessionToolSurface(lease.state, (kind, data) =>
      manager.appendCustomEntryAsync(kind, data),
    );
    const payload = convertResponsesToolPayload(prepared, { strict: false });
    if (session === 0 && run === 1) {
      canonical = finalized.map((tool) => tool.parameters);
    }
    if (session > 0 || run === 2) {
      finalized.forEach((tool, i) => {
        if (tool.parameters !== canonical[i]) {
          warmSchemaMisses++;
        }
      });
    }
    for (const cleanup of cleanups) {
      await cleanup("settled");
    }
    const used = process.threadCpuUsage(cpu);
    measurements.push({
      cpuUs: used.user + used.system,
      wallMs: performance.now() - time,
      allocatedBytes: getHeapStatistics().total_allocated_bytes - before,
    });
    payloadHashes.add(createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
    if (run === 2) {
      toolsets.push({ prepared, payload });
    }
  }
  for (let child = 0; child < 10; child++) {
    const row = compactSubagentRunForMemory({
      runId: `${runId}-child-${child}`,
      childSessionKey: `agent:main:subagent:${session}-${child}`,
      childAgentId: "main",
      requesterSessionKey: `agent:main:${sessionId}`,
      requesterDisplayKey: "main",
      task: `Synthetic child ${child}`,
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
      cleanupCompletedAt: 3,
      delivery: { status: "delivered" },
    });
    runRows.set(row.runId, row);
  }
}
const topology = buildSubagentRunReadTopology({
  runs: new Map(runRows),
  inMemoryRuns: runRows.values(),
});
assert.equal(warmSchemaMisses, 0);
assert(canonical.every((schema) => getPublishedRuntimeToolInputSchema(schema)));
assert.equal(topology.runsByChildSessionKey.size, 240);
const used = process.threadCpuUsage(cpuStart);
const elapsedMs = performance.now() - started;
const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocationStart;
globalThis.gc();
const heap = process.memoryUsage();
// Keep real owner graphs alive through snapshot; no content leaves the local proof directory.

writeFileSync(
  `${output}.json`,
  JSON.stringify(
    {
      node: process.version,
      sessions: 24,
      tools: 100,
      messages: 9600,
      subagents: 240,
      warmSchemaMisses,
      payloadHashes: [...payloadHashes],
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      allocationBytesPerSecond: allocatedBytes / (elapsedMs / 1000),
      heap,
      load: loadavg(),
      measurements,
    },
    null,
    2,
  ),
);
writeHeapSnapshot(`${output}.heapsnapshot`);

assert.equal(managers.length, 24);
assert.equal(toolsets.length, 24);
for (const lease of leases) {
  lease[Symbol.dispose]();
}
