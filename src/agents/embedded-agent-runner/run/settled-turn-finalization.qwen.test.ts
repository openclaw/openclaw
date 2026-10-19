import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";

function fixture(stopReason: "stop" | "length" = "stop", text?: string) {
  const assistant = buildEmbeddedRunnerAssistant({
    provider: "qwen-local",
    model: "qwen3.8-flash-next",
    api: "openai-completions",
    stopReason,
    content: [
      { type: "thinking", thinking: "Private reasoning", thinkingSignature: "opaque" },
      ...(text === undefined ? [] : [{ type: "text" as const, text }]),
    ],
  });
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: text === undefined ? [] : [text],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    // Projected context may omit the call batch. Settlement must then come from
    // this attempt's own metadata and lifecycle, never from a prior user turn.
    messagesSnapshot: [assistant],
    toolMetas: [{ toolName: "exec", toolCallId: "settled-exec", replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
  });
  const request = (required = true) =>
    resolveSettledTurnFinalizationRequest({
      runParams: { sessionId: "s", runId: "r", terminalReplyExpectation: required ? "required" : "optional" } as never,
      attempt,
      activeErrorContext: { provider: "qwen-local", model: "qwen3.8-flash-next" },
      modelApi: "openai-completions",
      executionContract: undefined,
      payloadsWithToolMedia: buildEmbeddedRunPayloads({
        assistantTexts: attempt.assistantTexts,
        lastAssistant: assistant,
        currentAssistant: assistant,
        sessionKey: "agent:sonnia:test",
      }),
      hasTerminalToolPresentation: false,
      terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
      settledTurnFinalizationAvailable: true,
    });
  return { assistant, attempt, request };
}

describe("Qwen settled-turn answer recovery without replay", () => {
  it.each(["stop", "length"] as const)("finalizes a signed reasoning-only %s", (stop) => {
    const { request } = fixture(stop);
    expect(request()).toContain("Tools are unavailable in this step");
    expect(request()).toContain("Do not repeat completed tool calls");
    expect(request(false)).toBeNull();
  });

  it("does not count bare truncated tool-call markup as an answer", () => {
    expect(fixture("length", "<tool_call>").request()).toContain("Tools are unavailable");
  });

  it("preserves a meaningful length-stop partial answer for truncation delivery", () => {
    expect(fixture("length", "The verified result so far is").request()).toBeNull();
  });

  it.each([
    ["unfinished lifecycle", (a: ReturnType<typeof fixture>["attempt"]) => { a.itemLifecycle = { startedCount: 2, completedCount: 1, activeCount: 1 }; }],
    ["async work", (a: ReturnType<typeof fixture>["attempt"]) => { a.toolMetas[0].asyncStarted = true; }],
    ["tool error", (a: ReturnType<typeof fixture>["attempt"]) => { a.toolMetas[0].isError = true; }],
    ["no tools", (a: ReturnType<typeof fixture>["attempt"]) => { a.toolMetas = []; a.itemLifecycle = { startedCount: 0, completedCount: 0, activeCount: 0 }; }],
    ["prior assistant only", (a: ReturnType<typeof fixture>["attempt"]) => { a.currentAttemptAssistant = undefined; a.currentAttemptCompletedAssistant = undefined; }],
    ["yield", (a: ReturnType<typeof fixture>["attempt"]) => { a.yieldDetected = true; }],
    ["accepted child", (a: ReturnType<typeof fixture>["attempt"]) => { a.acceptedSessionSpawns = [{ runId: "child", childSessionKey: "agent:sonnia:subagent:child" }]; }],
    ["provider failure", (a: ReturnType<typeof fixture>["attempt"]) => { a.terminal = { kind: "failed", source: "prompt", error: new Error("failure") }; }],
    ["runtime timeout", (a: ReturnType<typeof fixture>["attempt"]) => { a.terminal = { kind: "timeout", phase: "prompt", source: "runtime" }; }],
    ["last tool error", (a: ReturnType<typeof fixture>["attempt"]) => { a.lastToolError = { toolName: "exec", error: "failed" }; }],
  ] as const)("preserves the %s guard", (_name, change) => {
    const { attempt, request } = fixture("length");
    change(attempt);
    expect(request()).toBeNull();
    expect(attempt.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });
});
