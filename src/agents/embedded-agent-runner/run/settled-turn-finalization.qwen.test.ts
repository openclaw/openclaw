import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveSettledToolTerminalContinuation } from "./incomplete-turn-recovery.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function fixture(stopReason: "stop" | "length" = "stop", text?: string) {
  const assistant = buildEmbeddedRunnerAssistant({
    provider: "qwen-local",
    model: "qwen3:4b",
    api: "openai-completions",
    stopReason,
    content: [{ type: "thinking", thinking: "Private reasoning", thinkingSignature: "opaque" }],
  });
  if (text !== undefined) {
    assistant.content.push({ type: "text", text });
  }
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: text === undefined ? [] : [text],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    // Projection can omit the call batch; only this attempt's settlement counts.
    messagesSnapshot: [assistant],
    toolMetas: [{ toolName: "exec", toolCallId: "settled-exec", replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
  });
  const request = () =>
    resolveSettledToolTerminalContinuation({
      attempt,
      provider: "qwen-local",
      modelId: "qwen3:4b",
      modelApi: "openai-completions",
      allowEmptyStopContinuation: true,
      replyDeliveryState: "missing",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
    });
  return { attempt, request };
}

describe("settled-turn recovery for non-visible model output", () => {
  it.each(["stop", "length"] as const)("finalizes a signed reasoning-only %s", (stop) => {
    const { request } = fixture(stop);
    expect(request()?.instruction).toContain("Tools are unavailable in this step");
  });

  it("does not count bare truncated tool-call markup as an answer", () => {
    expect(fixture("length", "<tool_call>").request()?.instruction).toContain(
      "Tools are unavailable",
    );
  });

  it("uses the completed response when projection removes the current snapshot slot", () => {
    const { attempt, request } = fixture();
    attempt.currentAttemptAssistant = undefined;
    expect(request()?.instruction).toContain("Tools are unavailable");
  });

  it("preserves a meaningful length-stop partial answer for truncation delivery", () => {
    expect(fixture("length", "The verified result so far is").request()).toBeNull();
  });

  it.each([
    {
      label: "unfinished lifecycle",
      overrides: { itemLifecycle: { startedCount: 2, completedCount: 1, activeCount: 1 } },
    },
    { label: "async work", overrides: { toolMetas: [{ toolName: "exec", asyncStarted: true }] } },
    { label: "tool error", overrides: { toolMetas: [{ toolName: "exec", isError: true }] } },
    {
      label: "no tools",
      overrides: {
        toolMetas: [],
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      },
    },
    {
      label: "prior assistant only",
      overrides: {
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
      },
    },
    { label: "yield", overrides: { yieldDetected: true } },
    {
      label: "accepted child",
      overrides: {
        acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:subagent:child" }],
      },
    },
    {
      label: "provider failure",
      overrides: { terminal: { kind: "failed", source: "prompt", error: new Error("failure") } },
    },
    {
      label: "runtime timeout",
      overrides: { terminal: { kind: "timeout", phase: "prompt", source: "runtime" } },
    },
    {
      label: "last tool error",
      overrides: { lastToolError: { toolName: "exec", error: "failed" } },
    },
  ] satisfies { label: string; overrides: Partial<EmbeddedRunAttemptResult> }[])(
    "preserves the $label guard",
    ({ overrides }) => {
      const { attempt, request } = fixture("length");
      Object.assign(attempt, overrides);
      expect(request()).toBeNull();
    },
  );
});
