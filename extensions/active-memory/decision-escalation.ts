import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  DecisionBatch,
  DecisionOutcome,
  DecisionRuntimeV1,
  UnavailableReason,
} from "openclaw/plugin-sdk/decisions";
import type { RecallEscalationDecider } from "./escalation.js";

export const ACTIVE_MEMORY_ESCALATION_DECISION_PURPOSE = "active-memory/escalation";
export const ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION = "active-memory-escalation/1";
const DEEP_RECALL_QUESTION_ID = "deepRecall";
const RECALL_PROBABILITY_THRESHOLD = 0.5;

const DEEP_RECALL_QUESTION = {
  type: "boolean",
  instructions:
    "Decide whether answering the latest user message needs a search of earlier conversations or saved memory beyond the current turn.",
  criteria: {
    true: "The user refers to earlier conversations, prior decisions, stated preferences, or facts shared in past sessions.",
    false:
      "The message can be answered from the current turn alone, or it only concerns new or future work.",
  },
} as const;

/**
 * Mirrors the host's outer eligibility for automatic Decision consumers: the
 * default-off Decision assistance setting. The shared runtime separately
 * reports "disabled" when the owning agent has no Decision model selected.
 */
export function isActiveMemoryDecisionEscalationEligible(config: OpenClawConfig): boolean {
  return config.agents?.defaults?.experimental?.decisionAssistance === true;
}

export function buildActiveMemoryEscalationDecisionBatch(params: {
  message: string;
  searchQuery: string;
}): DecisionBatch {
  return {
    state: {
      latestUserMessage: params.message,
      searchQuery: params.searchQuery,
    },
    questions: { [DEEP_RECALL_QUESTION_ID]: DEEP_RECALL_QUESTION },
  };
}

export type ActiveMemoryDecisionAbstainReason = UnavailableReason | "invalid-answer";

export function mapActiveMemoryEscalationDecisionOutcome(
  outcome: DecisionOutcome,
):
  | { result: "recall" | "skip" }
  | { result: "abstain"; reason: ActiveMemoryDecisionAbstainReason } {
  if (outcome.status !== "ok") {
    return { result: "abstain", reason: outcome.reason };
  }
  const answer = outcome.result.answers[DEEP_RECALL_QUESTION_ID];
  if (
    answer?.type !== "boolean" ||
    !Number.isFinite(answer.probabilityTrue) ||
    answer.probabilityTrue < 0 ||
    answer.probabilityTrue > 1
  ) {
    return { result: "abstain", reason: "invalid-answer" };
  }
  return { result: answer.probabilityTrue >= RECALL_PROBABILITY_THRESHOLD ? "recall" : "skip" };
}

/**
 * Asks the owning agent's Decision model whether this turn needs deep recall.
 * Unavailable or unusable answers abstain so the built-in matcher decides.
 */
export function createActiveMemoryDecisionEscalationDecider(params: {
  decisions: Pick<DecisionRuntimeV1, "evaluate">;
  agentId: string;
  onAbstain?: (reason: ActiveMemoryDecisionAbstainReason) => void;
}): RecallEscalationDecider {
  return {
    async decide({ message, searchQuery, signal, timeoutMs }) {
      // The hook admitted this turn with its config; a change applies to the next turn.
      const outcome = await params.decisions.evaluate(
        buildActiveMemoryEscalationDecisionBatch({ message, searchQuery }),
        {
          agentId: params.agentId,
          purpose: ACTIVE_MEMORY_ESCALATION_DECISION_PURPOSE,
          // Recall escalation is best-effort: never take a provider's last slot.
          priority: "optional",
          rubricVersion: ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
          timeoutMs,
          signal,
        },
      );
      const mapped = mapActiveMemoryEscalationDecisionOutcome(outcome);
      if (mapped.result === "abstain") {
        params.onAbstain?.(mapped.reason);
      }
      return mapped.result;
    },
  };
}

/**
 * Builds the decider for one escalate-mode turn, or returns undefined so the
 * built-in matcher decides. Logs why an opted-in turn cannot use its model.
 */
export function createActiveMemoryTurnEscalationDecider(params: {
  requested: boolean;
  agentId: string | undefined;
  config: OpenClawConfig;
  decisions: Pick<DecisionRuntimeV1, "evaluate">;
  logger: { debug?: (message: string) => void };
}): RecallEscalationDecider | undefined {
  if (!params.requested) {
    return undefined;
  }
  if (!params.agentId || !isActiveMemoryDecisionEscalationEligible(params.config)) {
    params.logger.debug?.(
      "active-memory: escalation decision requires Decision assistance; using built-in matcher",
    );
    return undefined;
  }
  return createActiveMemoryDecisionEscalationDecider({
    decisions: params.decisions,
    agentId: params.agentId,
    onAbstain: (reason) => {
      params.logger.debug?.(
        `active-memory: escalation decision unavailable reason=${reason}; using built-in matcher`,
      );
    },
  });
}
