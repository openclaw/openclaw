import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "../usage-accumulator.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { EmbeddedRunTerminalState } from "./terminal-outcome.js";
import type { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";

export type OuterContextTokenMeta = Parameters<
  typeof prepareEmbeddedRunTerminal
>[0]["outerContextTokenMeta"];

export type TerminalStatsInput = {
  attempt?: Partial<EmbeddedRunAttemptWithReceiptEvidence> & {
    terminalTurnId?: string;
  };
  assistantTurns?: number;
  bridgeCalls?: { search: number; describe: number; call: number };
  config?: unknown;
  assistantProvider?: string;
  provider?: string;
  model?: string;
  outerContextTokenMeta?: OuterContextTokenMeta;
  responseModel?: string;
  usage?: Parameters<typeof mergeUsageIntoAccumulator>[1];
  attempts?: NonNullable<Parameters<typeof mergeUsageIntoAccumulator>[1]>[];
};

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

export async function prepareAttempt(input: {
  attempt: EmbeddedRunAttemptWithReceiptEvidence;
  admittedRunContext?: ReturnType<typeof createTestAdmittedRunContext>;
  currentAttemptCompletedAssistant?: AssistantMessage;
  sourceReplyDeliveryMode?: "message_tool_only";
  heartbeat?: { continuesConversation: boolean };
  terminalState: EmbeddedRunTerminalState;
}) {
  const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
  return prepareEmbeddedRunTerminal({
    runParams: {
      admittedRunContext: input.admittedRunContext ?? createTestAdmittedRunContext("run-focused"),
      sessionId: "session-focused",
      runId: "run-focused",
      workspaceDir: "/tmp/openclaw-test",
      prompt: "hi",
      trigger: input.heartbeat ? "heartbeat" : "user",
      ...(input.heartbeat?.continuesConversation ? { continuesConversation: true } : {}),
      timeoutMs: 60_000,
      ...(input.sourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: input.sourceReplyDeliveryMode }
        : {}),
    },
    attempt: input.attempt,
    currentAttemptCompletedAssistant: input.currentAttemptCompletedAssistant,
    provider: "openai",
    model: "gpt-5.4",
    activeErrorContext: { provider: "openai", model: "gpt-5.4" },
    authProfileStore: { version: 1, profiles: {} },
    sessionIdUsed: input.attempt.sessionIdUsed,
    outerContextTokenMeta: {},
    usageAccumulator: createUsageAccumulator(),
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    resolvedToolResultFormat: "markdown",
    terminalState: input.terminalState,
  });
}
