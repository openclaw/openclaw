import { isTerminalAssistantError } from "../../../llm/utils/retry.js";
import { resolveReplyExpectation, type ReplyDeliveryState } from "../../reply-completion.js";
import { resolveSourceReplyDelivery } from "../delivery-evidence.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { resolveCurrentAttemptAssistant } from "./attempt-terminal-evidence.js";
import { countSettledTurnDeliveryPayloads } from "./incomplete-turn-classification.js";
import {
  resolveReasoningOnlyRetryInstruction,
  resolveSettledToolTerminalContinuationInstruction,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn-recovery.js";
import { resolveSilentToolResultReplyPayload } from "./incomplete-turn-resolution.js";
import type { RunEmbeddedAgentInternalParams as TerminalRunParams } from "./internal-params.js";
import {
  isEmbeddedRunTerminalAbort,
  isEmbeddedRunTerminalTimeout,
  type EmbeddedRunTerminalState,
} from "./terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export function resolveSettledTurnFinalizationRequest(input: {
  runParams: TerminalRunParams;
  attempt: EmbeddedRunAttemptResult;
  activeErrorContext: { provider: string; model: string };
  modelApi: Parameters<typeof resolveReasoningOnlyRetryInstruction>[0]["modelApi"];
  executionContract: Parameters<
    typeof resolveReasoningOnlyRetryInstruction
  >[0]["executionContract"];
  payloadsWithToolMedia: EmbeddedAgentRunResult["payloads"];
  recoveredFinalAssistantPayloadsAfterPromptTimeout?: EmbeddedAgentRunResult["payloads"];
  hasTerminalToolPresentation: boolean;
  terminalState: EmbeddedRunTerminalState;
  settledTurnFinalizationAvailable: boolean;
  replyDeliveryState?: ReplyDeliveryState;
}): string | null {
  const terminalAssistant = resolveCurrentAttemptAssistant(input.attempt);
  if (
    !input.settledTurnFinalizationAvailable ||
    isTerminalAssistantError(terminalAssistant) ||
    resolveSourceReplyDelivery(input.attempt, input.replyDeliveryState) !== "missing"
  ) {
    return null;
  }
  const terminalAborted = isEmbeddedRunTerminalAbort(input.terminalState.outcome);
  const terminalTimedOut = isEmbeddedRunTerminalTimeout(input.terminalState.outcome);
  // Generated errors and pre-tool commentary are fallback surfaces, not authored answers.
  const preparedPayloadCount = countSettledTurnDeliveryPayloads({
    payloads: input.payloadsWithToolMedia,
    attempt: input.attempt,
  });
  const silentToolResultReplyPayload = resolveSilentToolResultReplyPayload({
    isCronTrigger: input.runParams.trigger === "cron",
    payloadCount: preparedPayloadCount,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt: input.attempt,
  });
  const payloadCount = input.recoveredFinalAssistantPayloadsAfterPromptTimeout
    ? input.recoveredFinalAssistantPayloadsAfterPromptTimeout.length
    : preparedPayloadCount || (silentToolResultReplyPayload ? 1 : 0);
  const emptyAssistantReplyIsSilent = shouldTreatEmptyAssistantReplyAsSilent({
    terminalReplyExpectation: resolveReplyExpectation(input.runParams),
    payloadCount,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt: input.attempt,
  });
  if (emptyAssistantReplyIsSilent) {
    return null;
  }
  return resolveSettledToolTerminalContinuationInstruction({
    provider: input.activeErrorContext.provider,
    modelId: input.activeErrorContext.model,
    modelApi: input.modelApi,
    executionContract: input.executionContract,
    allowEmptyStopContinuation: resolveReplyExpectation(input.runParams) === "required",
    payloadCount,
    hasTerminalToolPresentation: input.hasTerminalToolPresentation,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt: input.attempt,
  });
}
