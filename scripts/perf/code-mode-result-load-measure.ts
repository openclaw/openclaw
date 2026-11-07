/**
 * Saved-result bridge allocation/CPU attribution (synthetic data, no Gateway).
 * Run on each pinned revision: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/code-mode-result-load-measure.ts [--allocations] [--small]
 * Timing and allocation passes are separate; five samples of 2,000 loads each.
 * Each load verifies exact delivered JSON, then releases the real inbox lease.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { runBridgeRequest } from "../../src/agents/code-mode-bridge.js";
import { createCodeModeCatalogProjection } from "../../src/agents/code-mode-catalog.js";
import { createCodeModeNamespaceRuntime } from "../../src/agents/code-mode-namespaces.js";
import { CodeModeProgramDataInbox } from "../../src/agents/code-mode-program-data.js";
import {
  createCodeModeResultsAccess,
  disposeCodeModeResults,
} from "../../src/agents/code-mode-results.js";
import { resolveCodeModeConfig, toToolSearchConfig } from "../../src/agents/code-mode-runtime.js";
import { ToolSearchRuntime } from "../../src/agents/tool-search-runtime.js";
import type { ToolSearchToolContext } from "../../src/agents/tool-search-types.js";

const ctx: ToolSearchToolContext = {
  agentId: "main",
  sessionId: "synthetic-audit",
  runId: "synthetic-run",
  catalogRef: {
    current: {
      entries: [],
      counterScope: "synthetic",
      searchCount: 0,
      describeCount: 0,
      callCount: 0,
    },
  },
};
const config = resolveCodeModeConfig({ tools: { codeMode: true } });
const results = createCodeModeResultsAccess(ctx, config);
const inbox = new CodeModeProgramDataInbox(config);
const runtime = new ToolSearchRuntime(ctx, toToolSearchConfig(config));
const catalogProjection = createCodeModeCatalogProjection([]);
const namespaceRuntime = createCodeModeNamespaceRuntime();
const small = process.argv.includes("--small");
const value = {
  rows: Array.from({ length: small ? 1 : 512 }, (_, id) => ({
    id,
    text: `audit-${id}:` + "x".repeat(small ? 4 : 128),
  })),
};
const json = JSON.stringify(value);
const reference = results.save(value, false);
const request = { id: "load", method: "resultLoad" as const, args: [reference.id] };
async function load() {
  const reply = inbox.createReply("load");
  try {
    await runBridgeRequest({
      runtime,
      catalogProjection,
      namespaceRuntime,
      ctx,
      results,
      reply,
      request,
      parentToolCallId: "audit",
      codeModeRunId: "audit",
      remainingMs: 30_000,
    });
    const delivered = reply.take();
    assert.equal(delivered.ok, true);
    assert.equal(delivered.json, json);
  } finally {
    reply.release();
  }
}
const allocations = process.argv.includes("--allocations");
const inspector = new Session();
const gc: number[] = [];
let measurementStart = Infinity;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime >= measurementStart) {
      gc.push(entry.duration);
    }
  }
});
observer.observe({ entryTypes: ["gc"] });
try {
  for (let i = 0; i < 100; i++) {
    await load();
  }
  globalThis.gc?.();
  await setImmediate();
  gc.length = 0;
  if (allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const samples = [];
  measurementStart = performance.now();
  for (let sample = 0; sample < 5; sample++) {
    const before = process.threadCpuUsage();
    const start = performance.now();
    for (let i = 0; i < 2000; i++) {
      await load();
    }
    const cpu = process.threadCpuUsage(before);
    samples.push({
      operations: 2000,
      elapsedMs: performance.now() - start,
      cpuMs: (cpu.user + cpu.system) / 1000,
    });
    await setImmediate();
  }
  await setImmediate();
  let sampledBytes: number | undefined;
  let stacks: Array<{ bytes: number; stack: string[] }> | undefined;
  if (allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const nodes = [{ node: profile.head, stack: [] as string[] }];
    sampledBytes = 0;
    stacks = [];
    for (const { node, stack } of nodes) {
      const chain = [...stack, node.callFrame.functionName];
      sampledBytes += node.selfSize;
      if (node.selfSize) {
        stacks.push({ bytes: node.selfSize, stack: chain });
      }
      nodes.push(...node.children.map((child) => ({ node: child, stack: chain })));
    }
    stacks.sort((a, b) => b.bytes - a.bytes);
  }
  console.log(
    JSON.stringify({
      payloadBytes: Buffer.byteLength(json),
      operations: 10000,
      samples,
      sampledBytes,
      topStacks: stacks?.slice(0, 12),
      gcMs: gc.reduce((a, b) => a + b, 0),
      gcCount: gc.length,
      memory: process.memoryUsage(),
      hostLoad: loadavg(),
    }),
  );
} finally {
  observer.disconnect();
  if (allocations) {
    inspector.disconnect();
  }
  inbox.close();
  if (ctx.catalogRef) {
    disposeCodeModeResults(ctx.catalogRef);
  }
}
