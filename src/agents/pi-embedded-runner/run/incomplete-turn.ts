import { isLikelyMutatingToolName } from "../../tool-mutation.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type ReplayMetadataAttempt = Pick<
  EmbeddedRunAttemptResult,
  "toolMetas" | "didSendViaMessagingTool" | "successfulCronAdds"
>;

type IncompleteTurnAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "clientToolCall"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "lastToolError"
  | "lastAssistant"
  | "replayMetadata"
>;

type PlanningOnlyAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCall"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "lastToolError"
  | "lastAssistant"
  | "replayMetadata"
  | "toolMetas"
>;

const PLANNING_ONLY_PROMISE_RE =
  /\b(?:i(?:'ll| will)|let me|going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|i can do that)\b/i;
const PLANNING_ONLY_COMPLETION_RE =
  /\b(?:done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|blocked by|the blocker is)\b/i;

export const PLANNING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn only described the plan. Do not restate the plan. Act now: take the first concrete tool action you can. If a real blocker prevents action, reply with the exact blocker in one sentence.";

export function buildAttemptReplayMetadata(
  params: ReplayMetadataAttempt,
): EmbeddedRunAttemptResult["replayMetadata"] {
  const hadMutatingTools = params.toolMetas.some((t) => isLikelyMutatingToolName(t.toolName));
  const hadPotentialSideEffects =
    hadMutatingTools || params.didSendViaMessagingTool || (params.successfulCronAdds ?? 0) > 0;
  return {
    hadPotentialSideEffects,
    replaySafe: !hadPotentialSideEffects,
  };
}

export function resolveIncompleteTurnPayloadText(params: {
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (
    params.payloadCount !== 0 ||
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCall ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError
  ) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  if (stopReason !== "toolUse" && stopReason !== "error") {
    return null;
  }

  return params.attempt.replayMetadata.hadPotentialSideEffects
    ? "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying."
    : "⚠️ Agent couldn't generate a response. Please try again.";
}

function shouldApplyPlanningOnlyRetryGuard(params: {
  provider?: string;
  modelId?: string;
}): boolean {
  if (params.provider !== "openai" && params.provider !== "openai-codex") {
    return false;
  }
  return /^gpt-5(?:[.-]|$)/i.test(params.modelId ?? "");
}

export function resolvePlanningOnlyRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: PlanningOnlyAttempt;
}): string | null {
  if (
    !shouldApplyPlanningOnlyRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
    }) ||
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCall ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.didSendViaMessagingTool ||
    params.attempt.lastToolError ||
    params.attempt.toolMetas.length > 0 ||
    params.attempt.replayMetadata.hadPotentialSideEffects
  ) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  if (stopReason && stopReason !== "stop") {
    return null;
  }

  const text = params.attempt.assistantTexts.join("\n\n").trim();
  if (!text || text.length > 700 || text.includes("```")) {
    return null;
  }
  if (!PLANNING_ONLY_PROMISE_RE.test(text)) {
    return null;
  }
  if (PLANNING_ONLY_COMPLETION_RE.test(text)) {
    return null;
  }
  return PLANNING_ONLY_RETRY_INSTRUCTION;
}
