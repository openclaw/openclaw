import { expect, it } from "vitest";
import type { AssistantMessage } from "../../llm/types.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { createAttemptResult, createFinalAssistant } from "./lifecycle.test-support.js";
import { EmptySettledTurnFinalizationError } from "./settled-turn-finalization-outcome.js";
import {
  assertSettledTurnFinalizationResult,
  projectSettledTurnFinalizationAttemptResult,
} from "./settled-turn-finalization-result.js";
import type { AgentHarnessSettledTurnFinalizationResult } from "./types.js";

function safeResult(
  assistant: Partial<AssistantMessage> = {},
): AgentHarnessSettledTurnFinalizationResult {
  return { assistant: { ...createFinalAssistant(), ...assistant } };
}

function successfulAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  const assistant = createFinalAssistant();
  return {
    ...createAttemptResult(),
    diagnosticTrace: undefined,
    messagesSnapshot: [assistant],
    assistantTexts: ["done"],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    ...overrides,
  };
}

it("classifies a normally completed empty rendered answer", () => {
  const result = safeResult({ content: [{ type: "text", text: "  " }] });
  try {
    assertSettledTurnFinalizationResult(result);
    throw new Error("expected completed-empty classification");
  } catch (error) {
    expect(error).toBeInstanceOf(EmptySettledTurnFinalizationError);
    expect((error as EmptySettledTurnFinalizationError).result).toMatchObject(result);
  }
});

it.each<[string, AgentHarnessSettledTurnFinalizationResult]>([
  [
    "returned a tool call",
    safeResult({
      content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
      stopReason: "toolUse",
    }),
  ],
  [
    "unsuccessful stop reason: length",
    safeResult({ content: [{ type: "text", text: "partial" }], stopReason: "length" }),
  ],
  ["invalid assistant message index", { ...safeResult(), assistantMessageIndex: -1 }],
  [
    "unsupported result field: futureCapabilityEvidence",
    {
      ...safeResult(),
      futureCapabilityEvidence: true,
    } as AgentHarnessSettledTurnFinalizationResult,
  ],
])("rejects invalid finals: %s", (error, result) => {
  expect(() => assertSettledTurnFinalizationResult(result)).toThrow(error);
});

it("projects a successful full attempt into the narrow result", () => {
  const attempt = successfulAttempt({ lastAssistantTextMessageIndex: 2 });

  expect(projectSettledTurnFinalizationAttemptResult(attempt)).toMatchObject({
    assistant: attempt.currentAttemptCompletedAssistant,
    assistantMessageIndex: 2,
  });
});

it.each<[Partial<EmbeddedRunAttemptResult>, string]>([
  [{ compactionCount: 1 }, "did not complete successfully"],
  [
    {
      toolMetas: [{ toolName: "write" }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    },
    "reported capability activity",
  ],
  [
    {
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: false },
    },
    "reported capability activity",
  ],
  [{ currentAttemptCompletedAssistant: undefined }, "no completed assistant message"],
])("rejects a full attempt with %j", (overrides, error) => {
  expect(() => projectSettledTurnFinalizationAttemptResult(successfulAttempt(overrides))).toThrow(
    error,
  );
});
