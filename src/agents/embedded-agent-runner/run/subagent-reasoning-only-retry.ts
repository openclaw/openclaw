import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import type { ReplyDeliveryState } from "../../reply-completion.js";
import { resolveSourceReplyDelivery } from "../delivery-evidence.js";
import { hasAttemptTerminalState } from "./attempt-terminal-evidence.js";
import { resolveReasoningOnlyRetryInstruction } from "./incomplete-turn-recovery.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

// Leaf contract for the subagent reasoning-only retry. The caller passes the
// full terminal-resolution input; only the fields below are read, so this
// module stays a leaf and does not import terminal-resolution.ts (which
// would form a cycle with its value import of these helpers).
type SubagentReasoningOnlyInput = {
  runParams: { lane?: string };
  attempt: EmbeddedRunAttemptResult;
  replyDeliveryState?: ReplyDeliveryState;
  activeErrorContext: { provider: string; model: string };
  modelApi: Parameters<typeof resolveReasoningOnlyRetryInstruction>[0]["modelApi"];
  executionContract: Parameters<
    typeof resolveReasoningOnlyRetryInstruction
  >[0]["executionContract"];
  replayState: { hadPotentialSideEffects: boolean };
};

// The subagent lane tolerates empty replies (announce handoff), but a
// reasoning-only terminal turn is a provider failure, not intentional
// silence: the model consumed output budget on thinking and delivered
// nothing the requester can act on. The silent classification must not
// suppress its bounded retry. Explicit NO_REPLY still completes silently
// because resolveReasoningOnlyRetryInstruction rejects any turn with
// visible assistant text, and a source reply that already went out keeps
// the turn suppressed through the delivery check.
export function resolveSubagentReasoningOnlyRetryInstruction(params: {
  input: SubagentReasoningOnlyInput;
  settledTurnFinalizationAttempted: boolean;
  replyRecoverySuppressed: boolean;
  aborted: boolean;
  timedOut: boolean;
}): string | null {
  const { input } = params;
  const subagentReasoningOnlyRetryAllowed =
    input.runParams.lane === AGENT_LANE_SUBAGENT &&
    !params.settledTurnFinalizationAttempted &&
    resolveSourceReplyDelivery(input.attempt, input.replyDeliveryState) === "missing";
  if (
    !subagentReasoningOnlyRetryAllowed &&
    (params.replyRecoverySuppressed || params.settledTurnFinalizationAttempted)
  ) {
    return null;
  }
  return resolveReasoningOnlyRetryInstruction({
    provider: input.activeErrorContext.provider,
    modelId: input.activeErrorContext.model,
    modelApi: input.modelApi,
    executionContract: input.executionContract,
    aborted: params.aborted,
    timedOut: params.timedOut,
    attempt: input.attempt,
  });
}

// The exhausted error payload must surface even when the lane's silent
// contract suppressed the ordinary incomplete-turn text (subagent lane):
// the retry budget was spent and the turn still delivered nothing, so the
// requester must see a non-deliverable terminal turn, not a silent success.
// Fallback safety is replay evidence only; it does not depend on the
// suppressed incomplete-turn text. Other lanes keep the shared value, which
// is non-null there whenever this branch runs. The retained presentation is
// gated on that shared value in the caller, which is false whenever the
// subagent lane suppresses the ordinary text; the replay-safe conditions
// are identical, so when the exhausted value holds the retained summary
// must ride along with the error payload.
export function resolveSubagentReasoningOnlyExhaustion(params: {
  input: SubagentReasoningOnlyInput;
  terminalInterrupted: boolean;
  promptError: unknown;
  terminalAssistantError: boolean;
  incompleteTurnFallbackSafe: boolean;
  terminalToolPresentation: string | undefined;
  availableTerminalToolPresentation: string | undefined;
}): {
  incompleteTurnText: string;
  payloadCount: number;
  incompleteTurnFallbackSafe: boolean;
  terminalToolPresentation: string | undefined;
} {
  const { input } = params;
  const replaySafe =
    !params.terminalInterrupted &&
    !params.promptError &&
    !input.attempt.lastToolError &&
    !hasAttemptTerminalState(input.attempt) &&
    !params.terminalAssistantError &&
    !input.replayState.hadPotentialSideEffects;
  const exhaustedFallbackSafe =
    input.runParams.lane === AGENT_LANE_SUBAGENT ? replaySafe : params.incompleteTurnFallbackSafe;
  return {
    incompleteTurnText: "⚠️ Agent couldn't generate a response. Please try again.",
    payloadCount: 0,
    incompleteTurnFallbackSafe: exhaustedFallbackSafe,
    terminalToolPresentation: exhaustedFallbackSafe
      ? params.availableTerminalToolPresentation
      : params.terminalToolPresentation,
  };
}
