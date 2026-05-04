import { describe, expect, it } from "vitest";
import {
  awaitCompletionTruthFromPublicHost,
  createCompletionTruthPublicHostHook,
  createOnToolResultForwarder,
  createOnYieldForwarder,
  resolveCompletionTruthFromPublicHost,
} from "./host-runtime.js";
import type { CompletionWorkerOutput } from "./types.js";

function parseEnvelope(raw: string): CompletionWorkerOutput {
  return JSON.parse(raw) as CompletionWorkerOutput;
}

describe("completion truth public host runtime", () => {
  it("waits briefly for toolResult and prefers it over existing realtime hint", async () => {
    const hook = createCompletionTruthPublicHostHook();
    createOnYieldForwarder(hook)(JSON.stringify({ source: "hint", status: "yielded" }));
    setTimeout(() => createOnToolResultForwarder(hook)({ source: "tool", status: "done" }), 10);

    await expect(
      awaitCompletionTruthFromPublicHost({
        hook,
        timeoutMs: 100,
        waitPolicy: { toolResultPriorityWindowMs: 50 },
        parseRealtimeHint: parseEnvelope,
      }),
    ).resolves.toEqual({ source: "tool", status: "done" });
  });

  it("returns selected source observability for toolResult", async () => {
    const hook = createCompletionTruthPublicHostHook();
    createOnToolResultForwarder(hook)({ source: "tool", status: "done" });

    await expect(
      resolveCompletionTruthFromPublicHost({
        hook,
        timeoutMs: 50,
        waitPolicy: { toolResultPriorityWindowMs: 10 },
        parseRealtimeHint: parseEnvelope,
      }),
    ).resolves.toMatchObject({
      output: { source: "tool", status: "done" },
      selection: {
        source: "toolResult",
        confidence: "high",
      },
    });
  });

  it("falls back to realtime hint after toolResult priority window", async () => {
    const hook = createCompletionTruthPublicHostHook();
    createOnYieldForwarder(hook)(JSON.stringify({ source: "hint", status: "yielded" }));

    await expect(
      awaitCompletionTruthFromPublicHost({
        hook,
        timeoutMs: 80,
        waitPolicy: { toolResultPriorityWindowMs: 5 },
        parseRealtimeHint: parseEnvelope,
      }),
    ).resolves.toEqual({ source: "hint", status: "yielded" });
  });

  it("fails explicitly when no candidate is available", async () => {
    const hook = createCompletionTruthPublicHostHook();

    await expect(
      awaitCompletionTruthFromPublicHost({
        hook,
        timeoutMs: 10,
        waitPolicy: { toolResultPriorityWindowMs: 5 },
        parseRealtimeHint: parseEnvelope,
      }),
    ).rejects.toThrow(/Failed to resolve completion truth/);
  });
});
