import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  DecisionBatch,
  DecisionOutcome,
  DecisionRuntimeV1,
  UnavailableReason,
} from "openclaw/plugin-sdk/decisions";
import { resolveRememberAcrossConversations } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { normalizePluginConfig } from "./config.js";
import type { RecallEscalationDecider } from "./escalation.js";
import {
  isActiveMemoryPluginEnabled,
  isAllowedChatId,
  isEnabledForAgent,
} from "./session-policy.js";
import type { ActiveMemoryChatType } from "./types.js";

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

/** The turn a decision serves, as the hook resolved it. */
export type ActiveMemoryDecisionTarget = {
  agentId: string;
  chatType: ActiveMemoryChatType | undefined;
  privateDestination: boolean;
  destination: { sessionKey?: string; messageProvider?: string; channelId?: string };
};

/**
 * Live consent for one escalation decision: Active Memory enabled in escalate
 * mode with `escalationDecision`, plus Decision assistance, and, for a turn,
 * the same targeting that admitted it (configured agent, chat type and chat
 * id, or private "Remember across conversations" recall). Derived from the
 * given configuration exactly as the hook derives its invocation settings.
 */
export function readActiveMemoryDecisionConsent(
  config: OpenClawConfig,
  target?: ActiveMemoryDecisionTarget,
): boolean {
  const pluginConfig = isActiveMemoryPluginEnabled(config)
    ? (resolveLivePluginConfigObject(() => config, "active-memory") ?? {})
    : { enabled: false };
  const current = normalizePluginConfig(pluginConfig, config);
  const optedIn =
    current.enabled &&
    current.mode === "escalate" &&
    current.escalationDecision &&
    isActiveMemoryDecisionEscalationEligible(config);
  if (!optedIn || !target) {
    return optedIn;
  }
  if (!isAllowedChatId(current, target.destination)) {
    return false;
  }
  const configuredTarget =
    isEnabledForAgent(current, target.agentId) &&
    target.chatType !== undefined &&
    current.allowedChatTypes.includes(target.chatType);
  const privateRecallTarget =
    target.privateDestination && resolveRememberAcrossConversations(config, target.agentId);
  return configuredTarget || privateRecallTarget;
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

export type ActiveMemoryDecisionAbstainReason = UnavailableReason | "invalid-answer" | "revoked";

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
  /** Reads the current opt-in and turn targeting at the host's effect boundary. */
  isStillAllowed: () => boolean;
  onAbstain?: (reason: ActiveMemoryDecisionAbstainReason) => void;
}): RecallEscalationDecider {
  const revoked = (): "abstain" => {
    params.onAbstain?.("revoked");
    return "abstain";
  };
  return {
    async decide({ message, searchQuery, signal, timeoutMs }) {
      if (!params.isStillAllowed()) {
        return revoked();
      }
      // The host owns dispatch admission through provider/network preparation.
      // Keep the consumer check before use as well: an answer grants no authority.
      const outcome = await params.decisions.evaluate(
        buildActiveMemoryEscalationDecisionBatch({ message, searchQuery }),
        {
          agentId: params.agentId,
          purpose: ACTIVE_MEMORY_ESCALATION_DECISION_PURPOSE,
          rubricVersion: ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
          timeoutMs,
          signal,
          admit: params.isStillAllowed,
        },
      );
      if (!params.isStillAllowed()) {
        return revoked();
      }
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
  target: Omit<ActiveMemoryDecisionTarget, "agentId">;
  config: OpenClawConfig;
  readCurrentConfig: () => OpenClawConfig;
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
  const target = { ...params.target, agentId: params.agentId };
  return createActiveMemoryDecisionEscalationDecider({
    decisions: params.decisions,
    agentId: params.agentId,
    isStillAllowed: () => readActiveMemoryDecisionConsent(params.readCurrentConfig(), target),
    onAbstain: (reason) => {
      params.logger.debug?.(
        `active-memory: escalation decision unavailable reason=${reason}; using built-in matcher`,
      );
    },
  });
}
