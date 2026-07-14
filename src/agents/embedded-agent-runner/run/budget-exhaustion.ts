/**
 * Budget-exhaustion result builder and summary instruction.
 *
 * When an agent reaches its tool-calling round limit, this module provides:
 * 1. A summary instruction injected into the prompt for a final grace call
 * 2. A result builder for the budget_exhausted error kind
 * 3. The per-run controller that coordinates enforcement and summary state
 */

import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { resolveAgentMaxToolCallingRounds } from "../../agent-scope-config.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import {
  classifyAssistantFailoverReason,
  classifyFailoverReason,
} from "../../embedded-agent-helpers.js";
import { coerceToFailoverError, describeFailoverError } from "../../failover-error.js";
import type { EmbeddedAgentMeta, EmbeddedAgentRunMeta, EmbeddedAgentRunResult } from "../types.js";
import { isShortWindowRateLimitMessage } from "./assistant-failover.js";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";

type EmbeddedRunAttemptForRunner = Awaited<ReturnType<typeof runEmbeddedAttemptWithBackend>>;

/**
 * Instruction injected when the tool-calling round limit is reached. This gives
 * the LLM one final turn to summarize work done without making more tool calls.
 */
const BUDGET_EXHAUSTION_SUMMARY_INSTRUCTION =
  "You have reached the configured tool-calling round limit for this run. " +
  "Please provide a concise summary of what you have accomplished so far, " +
  "any remaining work that was not completed, and any important findings. " +
  "Do NOT make any tool calls in this response.";

function shouldReturnBudgetExhausted(params: {
  budgetExhausted: boolean;
  hasClientToolCalls: boolean;
  budgetSummaryAttempt: boolean;
  aborted: boolean;
  hasPromptError: boolean;
  timedOut: boolean;
  yieldDetected: boolean;
}): boolean {
  if (
    params.hasClientToolCalls ||
    params.budgetSummaryAttempt ||
    params.aborted ||
    params.hasPromptError ||
    params.timedOut ||
    params.yieldDetected
  ) {
    return false;
  }

  return params.budgetExhausted;
}

export function resolveBudgetSummaryProfileFailureReason(params: {
  attempt: EmbeddedRunAttemptForRunner;
  assistant?: AssistantMessage;
  provider: string;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  const { attempt } = params;
  if (
    attempt.promptError &&
    attempt.promptErrorSource !== "compaction" &&
    attempt.promptErrorSource !== "hook:before_agent_run"
  ) {
    const normalized = coerceToFailoverError(attempt.promptError, {
      provider: params.provider,
    });
    const details = describeFailoverError(normalized ?? attempt.promptError);
    const reason = details.reason ?? classifyFailoverReason(details.message, params);
    return resolveAuthProfileFailureReason({
      failoverReason: reason,
      providerStarted: attempt.promptErrorSource === "prompt",
      transientRateLimit: reason === "rate_limit" && isShortWindowRateLimitMessage(details.message),
      policy: params.policy,
    });
  }

  const providerStarted =
    Boolean(attempt.currentAttemptAssistant?.provider) ||
    attempt.promptTimeoutOutcome?.providerStarted === true ||
    (attempt.timedOut &&
      !attempt.timedOutDuringCompaction &&
      attempt.timedOutDuringToolExecution !== true);
  const reason =
    classifyAssistantFailoverReason(params.assistant) ??
    (providerStarted && (attempt.timedOut || attempt.idleTimedOut) ? "timeout" : null);
  return resolveAuthProfileFailureReason({
    failoverReason: reason,
    providerStarted,
    transientRateLimit:
      reason === "rate_limit" && isShortWindowRateLimitMessage(params.assistant?.errorMessage),
    policy: params.policy,
  });
}

/**
 * Build an EmbeddedAgentRunResult for a budget-exhausted run.
 */
function buildBudgetExhaustedResult(params: {
  message: string;
  durationMs: number;
  agentMeta?: EmbeddedAgentMeta;
  aborted?: boolean;
  budgetUsed: number;
  budgetMax: number;
  summaryText?: string;
  systemPromptReport?: EmbeddedAgentRunMeta["systemPromptReport"];
  finalPromptText?: string;
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  didSendViaMessagingTool?: EmbeddedAgentRunResult["didSendViaMessagingTool"];
  didDeliverSourceReplyViaMessageTool?: EmbeddedAgentRunResult["didDeliverSourceReplyViaMessageTool"];
  didSendDeterministicApprovalPrompt?: EmbeddedAgentRunResult["didSendDeterministicApprovalPrompt"];
  messagingToolSentTexts?: EmbeddedAgentRunResult["messagingToolSentTexts"];
  messagingToolSentMediaUrls?: EmbeddedAgentRunResult["messagingToolSentMediaUrls"];
  messagingToolSentTargets?: EmbeddedAgentRunResult["messagingToolSentTargets"];
  messagingToolSourceReplyPayloads?: EmbeddedAgentRunResult["messagingToolSourceReplyPayloads"];
  heartbeatToolResponse?: EmbeddedAgentRunResult["heartbeatToolResponse"];
  successfulCronAdds?: EmbeddedAgentRunResult["successfulCronAdds"];
  acceptedSessionSpawns?: EmbeddedAgentRunResult["acceptedSessionSpawns"];
}): EmbeddedAgentRunResult {
  const displayText =
    params.summaryText ??
    `Tool-calling round limit reached (${params.budgetUsed}/${params.budgetMax}). ${params.message}`;

  return {
    payloads: [
      {
        text: displayText,
        isError: !params.summaryText,
      },
    ],
    meta: {
      durationMs: params.durationMs,
      agentMeta: params.agentMeta,
      aborted: params.aborted,
      systemPromptReport: params.systemPromptReport,
      finalPromptText: params.finalPromptText,
      finalAssistantVisibleText: params.finalAssistantVisibleText,
      finalAssistantRawText: params.finalAssistantRawText,
      replayInvalid: true,
      livenessState: "blocked",
      error: {
        kind: "budget_exhausted",
        message: `Tool-calling round limit reached after ${params.budgetUsed} rounds (max: ${params.budgetMax}).`,
        fallbackSafe: false,
      },
    },
    didSendViaMessagingTool: params.didSendViaMessagingTool,
    didDeliverSourceReplyViaMessageTool: params.didDeliverSourceReplyViaMessageTool,
    didSendDeterministicApprovalPrompt: params.didSendDeterministicApprovalPrompt,
    messagingToolSentTexts: params.messagingToolSentTexts,
    messagingToolSentMediaUrls: params.messagingToolSentMediaUrls,
    messagingToolSentTargets: params.messagingToolSentTargets,
    messagingToolSourceReplyPayloads: params.messagingToolSourceReplyPayloads,
    heartbeatToolResponse: params.heartbeatToolResponse,
    successfulCronAdds: params.successfulCronAdds,
    acceptedSessionSpawns: params.acceptedSessionSpawns,
  };
}

class ToolCallingRoundLimitController {
  readonly summaryInstruction = BUDGET_EXHAUSTION_SUMMARY_INSTRUCTION;
  private usedRounds = 0;
  private exhausted = false;
  private summaryPendingValue = false;
  private summaryRecoveryAttempts = 0;
  private summaryToolCallBlocked = false;
  private evidenceAttempt?: EmbeddedRunAttemptForRunner;

  constructor(
    readonly max: number,
    private readonly startedAt: number,
  ) {}

  readonly beforeRound = (): boolean => {
    if (this.usedRounds >= this.max) {
      this.exhausted = true;
      this.summaryToolCallBlocked ||= this.summaryPendingValue;
      return false;
    }
    this.usedRounds += 1;
    return true;
  };

  request(
    attempt: EmbeddedRunAttemptForRunner,
    aborted: boolean,
    hasPromptError: boolean,
    timedOut: boolean,
  ): boolean {
    if (
      !shouldReturnBudgetExhausted({
        budgetExhausted: this.exhausted,
        hasClientToolCalls: Boolean(attempt.clientToolCalls),
        budgetSummaryAttempt: false,
        aborted,
        hasPromptError,
        timedOut,
        yieldDetected: Boolean(attempt.yieldDetected),
      })
    ) {
      return false;
    }
    this.evidenceAttempt = attempt;
    this.summaryPendingValue = true;
    return true;
  }

  finish(
    attempt: EmbeddedRunAttemptForRunner,
    agentMeta: EmbeddedAgentMeta | undefined,
    aborted: boolean,
    markTerminal: (meta: { replayInvalid: true; livenessState: "blocked" }) => void,
    failed: boolean,
  ): EmbeddedAgentRunResult {
    if (!this.summaryPendingValue) {
      throw new Error("Budget summary terminalization requires a pending summary");
    }
    this.summaryPendingValue = false;
    const evidence = this.evidenceAttempt ?? attempt;
    const summaryText =
      failed ||
      attempt.aborted ||
      attempt.timedOut ||
      attempt.idleTimedOut ||
      Boolean(attempt.promptError) ||
      this.summaryToolCallBlocked
        ? undefined
        : (attempt.assistantTexts ?? []).join("").trim() || undefined;
    markTerminal({ replayInvalid: true, livenessState: "blocked" });
    return buildBudgetExhaustedResult({
      message: "The agent reached its tool-calling round limit.",
      durationMs: Date.now() - this.startedAt,
      agentMeta,
      aborted,
      budgetUsed: this.used,
      budgetMax: this.max,
      summaryText,
      systemPromptReport: attempt.systemPromptReport,
      finalPromptText: attempt.finalPromptText,
      finalAssistantVisibleText: summaryText,
      didSendViaMessagingTool: evidence.didSendViaMessagingTool,
      didDeliverSourceReplyViaMessageTool: evidence.didDeliverSourceReplyViaMessageTool === true,
      didSendDeterministicApprovalPrompt: evidence.didSendDeterministicApprovalPrompt,
      messagingToolSentTexts: evidence.messagingToolSentTexts,
      messagingToolSentMediaUrls: evidence.messagingToolSentMediaUrls,
      messagingToolSentTargets: evidence.messagingToolSentTargets,
      messagingToolSourceReplyPayloads: evidence.messagingToolSourceReplyPayloads,
      heartbeatToolResponse: evidence.heartbeatToolResponse,
      successfulCronAdds: evidence.successfulCronAdds,
      acceptedSessionSpawns: evidence.acceptedSessionSpawns,
    });
  }

  get used(): number {
    return this.usedRounds;
  }

  get summaryPending(): boolean {
    return this.summaryPendingValue;
  }

  exhaustsRecovery(maxAttempts: number): boolean {
    if (!this.summaryPendingValue) {
      return false;
    }
    if (this.summaryRecoveryAttempts >= Math.max(1, maxAttempts)) {
      this.summaryToolCallBlocked = true;
      return true;
    }
    this.summaryRecoveryAttempts += 1;
    return false;
  }
}

export function createToolLimit(
  params: { config?: OpenClawConfig; spawnedBy?: unknown },
  agentId: string,
  startedAt: number,
): ToolCallingRoundLimitController | undefined {
  if (!params.config) {
    return undefined;
  }
  const max = resolveAgentMaxToolCallingRounds(params.config, agentId, Boolean(params.spawnedBy));
  return max === undefined ? undefined : new ToolCallingRoundLimitController(max, startedAt);
}
