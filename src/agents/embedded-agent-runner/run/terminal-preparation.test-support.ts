import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";

export function assistantMessage(
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: createZeroUsageFixture(),
    role: "assistant",
    content: [
      {
        type: "text",
        text: "provider error details",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ],
    timestamp: 0,
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
  };
}

export function attemptResult(
  overrides: Partial<EmbeddedRunAttemptWithReceiptEvidence> = {},
): EmbeddedRunAttemptWithReceiptEvidence {
  const assistant = assistantMessage("error");
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [assistant],
    assistantTexts: ["provider error details"],
    toolMetas: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...overrides,
  };
}
