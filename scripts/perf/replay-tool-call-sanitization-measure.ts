/**
 * Replay sanitation owner benchmark; synthetic tool-heavy history, no provider I/O.
 * node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/replay-tool-call-sanitization-measure.ts cpu [owner-path]
 * Use allocation for a separate 4 KiB sampling pass including collected objects.
 * An optional pristine owner module beside the original resolves identical imports.
 * Run five alternating base/candidate passes per mode. Each case warms 100 calls,
 * then measures 2,000 calls over 200/1,000/2,000 messages, three parallel tools per
 * turn, with signed thinking on every fourth turn. Both Responses and preserved
 * Anthropic thinking paths assert unchanged history identity before measurement.
 * Accept lower allocation/CPU with identical replay; report GC and host load.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Context } from "../../packages/llm-core/src/types.js";
import type { StreamFn } from "../../src/agents/runtime/index.js";
import { makeAssistantMessageFixture } from "../../src/agents/test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../src/agents/test-helpers/provider-model-fixture.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.js";

const mode = process.argv[2];
assert(mode === "cpu" || mode === "allocation", "expected cpu or allocation");
assert(globalThis.gc, "--expose-gc required");
const owner = resolve(
  process.argv[3] ??
    "src/agents/embedded-agent-runner/run/attempt-tool-call-replay-sanitization.ts",
);
const { wrapStreamFnSanitizeMalformedToolCalls } = (await import(
  pathToFileURL(owner).href
)) as typeof import("../../src/agents/embedded-agent-runner/run/attempt-tool-call-replay-sanitization.js");
const iterations = 2_000;
const inspector = new Session();
inspector.connect();
for (const signed of [false, true]) {
  const model = makeProviderModelFixture({
    id: "synthetic",
    provider: "synthetic",
    baseUrl: "https://example.test",
    api: signed ? "anthropic-messages" : "openai-responses",
  });
  let forwarded: Context["messages"] | undefined;
  const capture: StreamFn = (_model, context) => {
    forwarded = context.messages;
    return undefined as never;
  };
  const run = wrapStreamFnSanitizeMalformedToolCalls(capture, new Set(["read"]), {
    validateGeminiTurns: false,
    validateAnthropicTurns: signed,
    preserveSignatures: signed,
    dropThinkingBlocks: false,
  });
  for (const count of [200, 1_000, 2_000]) {
    const messages: Context["messages"] = [];
    for (let turn = 0; turn < count / 5; turn++) {
      const calls = Array.from({ length: 3 }, (_, index) => ({
        type: "toolCall" as const,
        id: `call_${turn}_${index}`,
        name: "read",
        arguments: { path: `synthetic/${turn}/${index}`, context: "x".repeat(256) },
      }));
      messages.push({ role: "user", content: "Read the synthetic files", timestamp: turn });
      messages.push(
        makeAssistantMessageFixture({
          stopReason: "toolUse",
          content: [
            ...(turn % 4 === 0
              ? [
                  {
                    type: "thinking" as const,
                    thinking: "synthetic",
                    thinkingSignature: "signature",
                  },
                ]
              : []),
            { type: "text", text: "Inspecting files" },
            ...calls,
          ],
        }),
      );
      for (const call of calls) {
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: "read",
          content: [{ type: "text", text: "synthetic result" }],
          isError: false,
          timestamp: turn,
        });
      }
    }
    const context = { messages };
    const turn = () => {
      void run(model, context);
    };
    for (let i = 0; i < 100; i++) {
      turn();
    }
    assert.equal(forwarded, messages);
    globalThis.gc();
    await setImmediate();
    let gcMs = 0;
    let gcCount = 0;
    let gcMaxMs = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcMs += entry.duration;
        gcCount++;
        gcMaxMs = Math.max(gcMaxMs, entry.duration);
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    if (mode === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    for (let i = 0; i < iterations; i++) {
      turn();
    }
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    const bytes =
      mode === "allocation"
        ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
    await setImmediate();
    await setImmediate();
    observer.disconnect();
    assert.equal(forwarded, messages);
    console.log(
      JSON.stringify({
        mode,
        owner,
        signed,
        count,
        iterations,
        elapsedMs,
        cpuUsPerCall: (cpu.user + cpu.system) / iterations,
        allocatedBytesPerCall: bytes === undefined ? undefined : bytes / iterations,
        gcMs,
        gcCount,
        gcMaxMs,
        load: loadavg(),
        memory: process.memoryUsage(),
      }),
    );
  }
}
inspector.disconnect();
