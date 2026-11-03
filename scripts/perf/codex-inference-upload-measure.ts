/**
 * Dispatch + upload-admission owner probe; serial traffic over 64 synthetic thread IDs.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/codex-inference-upload-measure.ts
 * Add --sample for a separate collected-object allocation pass (timing is untraced).
 * Five counterbalanced pairs, 1,000 requests per arm, 40 tool declarations per request.
 * Baseline repeats the forwarding composition from b4bce788b95a; candidate consumes
 * dispatch's signal directly. Real dispatch, context and upload admission run in both.
 * The loopback relay regression separately proves production forwarding composes once.
 * Acceptance: identical bytes/admission, lower allocation and CPU; cancellation is
 * covered by relay tests. Excludes socket I/O, TLS, concurrency and provider latency.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { createCodexInferenceContext } from "../../extensions/codex/src/app-server/inference-context.js";
import { createCodexInferenceDispatch } from "../../extensions/codex/src/app-server/inference-dispatch.js";
import { createUploadAdmission } from "../../extensions/codex/src/app-server/inference-upload.js";

const { values } = parseArgs({ options: { sample: { type: "boolean", default: false } } });
const iterations = 1000;
const tools = Array.from({ length: 40 }, (_, index) => ({
  type: "function",
  name: `synthetic_tool_${index}`,
  description: "Read a synthetic workspace resource.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}));
const frames = Array.from({ length: 64 }, (_, index) =>
  Buffer.from(
    JSON.stringify({
      type: "response.create",
      model: "synthetic-model",
      tools,
      input: [
        { role: "user", content: "Inspect the synthetic workspace." },
        {
          type: "function_call",
          call_id: "synthetic",
          name: "synthetic_tool_0",
          arguments: '{"path":"src"}',
        },
        {
          type: "function_call_output",
          call_id: "synthetic",
          output: "Synthetic resource contents.",
        },
      ],
      client_metadata: {
        thread_id: `synthetic-child-${index}`,
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: `synthetic-child-${index}`,
          parent_thread_id: "synthetic-parent",
          request_kind: "turn",
        }),
      },
    }),
  ),
);
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
function fixture() {
  const lifetime = new AbortController();
  const connection = new AbortController();
  const model = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, connection.signal]);
  const context = createCodexInferenceContext(() => signal.throwIfAborted());
  const execution = {
    signal: model.signal,
    assertCurrent: () => model.signal.throwIfAborted(),
    release: () => {},
  };
  const dispatch = createCodexInferenceDispatch({
    context,
    assertCurrent: () => signal.throwIfAborted(),
    bindModelExecution: () => execution,
  });
  const acquire = createUploadAdmission();
  return {
    async run(baseline: boolean, count: number) {
      for (let index = 0; index < count; index++) {
        const bytes = frames[index % frames.length]!;
        const prepared = await dispatch.prepare(bytes, "/responses", {}, signal, "websocket");
        const requestSignal = baseline
          ? AbortSignal.any([signal, ...(prepared.signal ? [prepared.signal] : [])])
          : prepared.signal;
        const release = await acquire(requestSignal, Date.now() + 30_000, prepared.bytes.length);
        requestSignal.throwIfAborted();
        prepared.assertCurrent();
        assert(release);
        assert.equal(prepared.bytes, bytes);
        release();
        prepared.release();
      }
    },
    close() {
      context.close();
      model.abort();
      connection.abort();
      lifetime.abort();
    },
  };
}
const inspector = values.sample ? new Session() : undefined;
inspector?.connect();
const results = [];
try {
  for (let pair = 0; pair < 5; pair++) {
    for (const baseline of pair % 2 ? [false, true] : [true, false]) {
      const run = fixture();
      await run.run(baseline, 200);
      globalThis.gc?.();
      const hostLoad = loadavg();
      if (inspector) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpuBefore = process.cpuUsage();
      const start = performance.now();
      await run.run(baseline, iterations);
      const wallMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuBefore);
      const allocationBytes = inspector
        ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      results.push({
        pair,
        arm: baseline ? "base" : "candidate",
        iterations,
        wallMs,
        cpuMs: (cpu.user + cpu.system) / 1000,
        allocationBytes,
        hostLoad,
      });
      run.close();
    }
  }
} finally {
  inspector?.disconnect();
}
console.log(JSON.stringify({ mode: values.sample ? "allocation" : "timing", results }, null, 2));
