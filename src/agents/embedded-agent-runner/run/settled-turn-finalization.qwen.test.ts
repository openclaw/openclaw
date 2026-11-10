import { expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant as makeAssistant,
  makeEmbeddedRunnerAttempt as makeAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveSettledToolTerminalContinuation } from "./incomplete-turn-recovery.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function recover(
  stopReason: "stop" | "length" = "stop",
  text?: string,
  overrides: Partial<EmbeddedRunAttemptResult> = {},
) {
  const assistant = makeAssistant({
    provider: "qwen-local",
    model: "qwen3:4b",
    api: "openai-completions",
    stopReason,
    content: [{ type: "thinking", thinking: "Private reasoning", thinkingSignature: "opaque" }],
  });
  if (text !== undefined) {
    assistant.content.push({ type: "text", text });
  }
  const attempt = makeAttempt({
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
  return resolveSettledToolTerminalContinuation({
    attempt: { ...attempt, ...overrides },
    provider: assistant.provider,
    modelId: assistant.model,
    modelApi: assistant.api,
    allowEmptyStopContinuation: true,
    replyDeliveryState: "missing",
    payloadCount: 0,
    aborted: false,
    timedOut: false,
  });
}

it.each([
  ["stop", undefined, false],
  ["length", undefined, false],
  ["length", "<tool_call>", false],
  ["stop", undefined, true],
] as const)("finalizes non-visible %s/%s (projected=%s)", (stop, text, projected) => {
  expect(
    recover(stop, text, projected ? { currentAttemptAssistant: undefined } : {}),
  ).toMatchObject({
    disableTools: true,
    instruction: expect.any(String),
  });
});

it("preserves a meaningful length-stop partial answer for truncation delivery", () => {
  expect(recover("length", "The verified result so far is")).toBeNull();
});

it.each<[string, Partial<EmbeddedRunAttemptResult>]>([
  [
    "unfinished lifecycle",
    { itemLifecycle: { startedCount: 2, completedCount: 1, activeCount: 1 } },
  ],
  ["async work", { toolMetas: [{ toolName: "exec", asyncStarted: true }] }],
  ["tool error", { toolMetas: [{ toolName: "exec", isError: true }] }],
  [
    "no tools",
    { toolMetas: [], itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 } },
  ],
  [
    "prior assistant only",
    { currentAttemptAssistant: undefined, currentAttemptCompletedAssistant: undefined },
  ],
  ["yield", { yieldDetected: true }],
  [
    "accepted child",
    { acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:subagent:child" }] },
  ],
  [
    "provider failure",
    { terminal: { kind: "failed", source: "prompt", error: new Error("failure") } },
  ],
  ["runtime timeout", { terminal: { kind: "timeout", phase: "prompt", source: "runtime" } }],
  ["last tool error", { lastToolError: { toolName: "exec", error: "failed" } }],
])("preserves the %s guard", (_label, overrides) => {
  expect(recover("length", undefined, overrides)).toBeNull();
});
