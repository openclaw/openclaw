import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { createUsageAccumulator, type mergeUsageIntoAccumulator } from "../usage-accumulator.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";

type PreparationInput = Parameters<typeof prepareEmbeddedRunTerminal>[0];
export type OuterContextTokenMeta = PreparationInput["outerContextTokenMeta"];
export type TerminalStatsInput = {
  attempt?: Partial<EmbeddedRunAttemptWithReceiptEvidence> & { terminalTurnId?: string };
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
const finalSignature = JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" });
export function assistantMessage(
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return buildEmbeddedRunnerAssistant({
    api: "responses",
    model: "gpt-5.4",
    usage: createZeroUsageFixture(),
    content: [{ type: "text", text: "provider error details", textSignature: finalSignature }],
    timestamp: 0,
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
  });
}

export function attemptResult(
  overrides: Partial<EmbeddedRunAttemptWithReceiptEvidence> = {},
  assistant = assistantMessage("error"),
): EmbeddedRunAttemptWithReceiptEvidence {
  return makeEmbeddedRunnerAttempt({
    sessionIdUsed: "session-1",
    messagesSnapshot: [assistant],
    assistantTexts: ["provider error details"],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    ...overrides,
  });
}

type PreparationOverrides = Partial<Omit<PreparationInput, "attempt" | "runParams">> & {
  attempt: PreparationInput["attempt"];
  runParams?: Partial<PreparationInput["runParams"]>;
  admittedRunContext?: PreparationInput["runParams"]["admittedRunContext"];
  sourceReplyDeliveryMode?: "message_tool_only";
  heartbeat?: { continuesConversation: boolean };
};

function preparationInput(input: PreparationOverrides): PreparationInput {
  const { admittedRunContext, sourceReplyDeliveryMode, heartbeat, runParams, ...overrides } = input;
  return {
    runParams: {
      admittedRunContext: admittedRunContext ?? createTestAdmittedRunContext("run-focused"),
      sessionId: "session-focused",
      runId: "run-focused",
      workspaceDir: "/tmp/openclaw-test",
      prompt: "hi",
      trigger: heartbeat ? "heartbeat" : "user",
      ...(heartbeat?.continuesConversation ? { continuesConversation: true } : {}),
      timeoutMs: 60_000,
      ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}),
      ...runParams,
    },
    provider: "openai",
    model: "gpt-5.4",
    activeErrorContext: { provider: "openai", model: "gpt-5.4" },
    authProfileStore: { version: 1, profiles: {} },
    sessionIdUsed: input.attempt.sessionIdUsed,
    outerContextTokenMeta: {},
    usageAccumulator: createUsageAccumulator(),
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    resolvedToolResultFormat: "markdown",
    terminalState: {
      outcome: { reason: "completed", status: "ok", stopReason: "stop" },
      signalOwnedInterruption: false,
    },
    ...overrides,
  };
}

export async function prepareAttempt(input: PreparationOverrides) {
  const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
  return prepareEmbeddedRunTerminal(preparationInput(input));
}
