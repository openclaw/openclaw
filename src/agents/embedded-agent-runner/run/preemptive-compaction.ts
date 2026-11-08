import { resolveCompactionReplayPressure } from "@openclaw/ai/transports";
import type { Model } from "@openclaw/llm-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringTokenPressure,
} from "@openclaw/normalization-core/cjk-chars";
import type { SessionContextBudgetStatus } from "../../../config/sessions.js";
import { resolveEffectiveCompactionReserveTokens } from "../../agent-compaction-constants.js";
import type { AgentMessage, StreamFn } from "../../runtime/index.js";
import { calculateContextTokens, IMAGE_BLOCK_TOKENS } from "../../runtime/index.js";
import {
  SAFETY_MARGIN,
  createFreshLlmBoundaryTokenEstimator,
  estimateJsonPayloadTokenPressure,
  estimateMessageTokenPressure,
  estimateRenderedPromptTokens,
  estimateToolSchemaTokens,
  type FixedRequestTokenPressure,
} from "../../sessions/context-token-pressure.js";
import type { MeasuredRequestContext } from "../prompt-cache-request-observer.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;

type CompactionPressureDecision = {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  pressureSource?: string;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

/** Diagnostic maximum plus the independently selected outgoing checkpoint's budget. */
export type PreemptiveCompactionDecision = CompactionPressureDecision & {
  compactionReplay?: CompactionPressureDecision;
};

export type CompactionReplayPressureContext = {
  model: Model;
  sessionId?: string;
  authProfileId?: string;
  enabled?: boolean;
};

/** Token pressure reported by the rendered provider-boundary prompt when available. */
export type LlmBoundaryTokenPressure = {
  estimatedPromptTokens: number;
  source: string;
  renderedChars?: number;
};

type TranscriptBoundaryTokenPressure = {
  estimatedPromptTokens: number;
  source: string;
  messages: AgentMessage[];
  hasCompactionReplay: boolean;
};

function isProviderContextUsageBarrier(message: AgentMessage): boolean {
  if (message.role !== "assistant" || !message.usage) {
    return false;
  }
  // Zero unavailable and legacy CLI records describe a newer context without
  // provider provenance; scanning past them can undercount the active transcript.
  return (
    (message.api === "cli" && message.usage.contextUsage === undefined) ||
    (message.usage.contextUsage?.state === "unavailable" &&
      calculateContextTokens(message.usage) === 0)
  );
}

function resolveProviderContextBoundary(
  messages: AgentMessage[],
): { index: number; totalTokens: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isProviderContextUsageBarrier(message)) {
      return undefined;
    }
    const contextUsage = message?.role === "assistant" ? message.usage?.contextUsage : undefined;
    if (
      contextUsage?.state === "available" &&
      Number.isFinite(contextUsage.totalTokens) &&
      contextUsage.totalTokens > 0
    ) {
      return { index, totalTokens: Math.ceil(contextUsage.totalTokens) };
    }
  }
  return undefined;
}

export function estimateToolSchemaTokenPressure(
  tools: Parameters<typeof estimateToolSchemaTokens>[0],
): number {
  return Math.ceil(estimateToolSchemaTokens(tools) * SAFETY_MARGIN);
}

function estimateTranscriptBoundaryTokenPressure(
  params: Parameters<typeof estimateLlmBoundaryTokenPressure>[0] & {
    llmBoundaryTokenPressure?: LlmBoundaryTokenPressure | (() => LlmBoundaryTokenPressure);
  },
): TranscriptBoundaryTokenPressure {
  const replay = params.replay
    ? resolveCompactionReplayPressure(
        params.messages,
        params.replay.model,
        params.replay,
        {
          text: estimateStringTokenPressure,
          image: () => IMAGE_BLOCK_TOKENS,
          json: estimateJsonPayloadTokenPressure,
          toolResult: estimateStringTokenPressure,
        },
        params.systemPrompt,
        params.requestContext,
      )
    : undefined;
  // Resolve the outgoing replay first: a fresh full-history estimate would be discarded.
  const boundaryPressure = !replay
    ? normalizeLlmBoundaryTokenPressure(
        typeof params.llmBoundaryTokenPressure === "function"
          ? params.llmBoundaryTokenPressure()
          : params.llmBoundaryTokenPressure,
      )
    : undefined;
  if (boundaryPressure) {
    return { ...boundaryPressure, messages: params.messages, hasCompactionReplay: false };
  }
  const messages = replay?.messages ?? params.messages;
  const boundary = resolveProviderContextBoundary(messages);
  const measuredTokens = replay?.measuredTokens ?? boundary?.totalTokens;
  // The provider total owns transcript items through its assistant record. It has
  // no system-prompt provenance, so the current rendered prompt stays local too.
  const messagesForPressure = boundary ? messages.slice(boundary.index + 1) : messages;
  const locallyEstimatedTokens = messagesForPressure.reduce(
    (sum, message) => sum + estimateMessageTokenPressure(message),
    (params.fixedTokenPressure
      ? params.fixedTokenPressure.systemTokens +
        estimateRenderedPromptTokens({ prompt: params.prompt })
      : estimateRenderedPromptTokens(params)) +
      (boundary ? 0 : (replay?.prefixTokens ?? 0) - (replay?.measuredTokens ?? 0)),
  );
  const toolSchemaTokens = Math.max(
    0,
    params.toolSchemaTokens ??
      (replay && params.requestContext
        ? Math.ceil(
            (params.fixedTokenPressure?.toolTokens ??
              estimateToolSchemaTokens(params.requestContext.tools)) * SAFETY_MARGIN,
          )
        : 0),
  );
  return {
    estimatedPromptTokens:
      (measuredTokens ?? 0) +
      Math.ceil(locallyEstimatedTokens * SAFETY_MARGIN) +
      // A saved replay prefix does not bind today's tool definitions. Reserve
      // their current size even when covered conversation usage is measured.
      (boundary && !replay ? 0 : toolSchemaTokens),
    source:
      measuredTokens !== undefined
        ? "provider_context_usage"
        : replay
          ? "provider_compaction_estimate"
          : "transcript_estimate",
    messages,
    hasCompactionReplay: Boolean(replay),
  };
}

export function estimateLlmBoundaryTokenPressure(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  replay?: CompactionReplayPressureContext;
  toolSchemaTokens?: number;
  requestContext?: Parameters<StreamFn>[1];
  fixedTokenPressure?: FixedRequestTokenPressure;
}): number {
  return estimateTranscriptBoundaryTokenPressure(params).estimatedPromptTokens;
}

/** Estimates only the rendered prompt/system portion when history has already been accounted for. */
export function estimateRenderedLlmBoundaryTokenPressure(params: {
  systemPrompt?: string;
  prompt: string;
}): number {
  return Math.max(0, Math.ceil(estimateRenderedPromptTokens(params) * SAFETY_MARGIN));
}

function normalizeLlmBoundaryTokenPressure(
  pressure: LlmBoundaryTokenPressure | undefined,
): LlmBoundaryTokenPressure | undefined {
  if (!pressure || !Number.isFinite(pressure.estimatedPromptTokens)) {
    return undefined;
  }
  const estimatedPromptTokens = Math.max(0, Math.ceil(pressure.estimatedPromptTokens));
  return {
    estimatedPromptTokens,
    source: pressure.source.trim() || "rendered_llm_boundary",
  };
}

/**
 * Decides whether a run should compact before submitting the prompt, and
 * whether reducible tool results can avoid or follow compaction. Rendered LLM
 * boundary pressure wins over local transcript estimates when supplied.
 */
export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  unwindowedMessages?: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
  toolSchemaTokens?: number;
  llmBoundaryTokenPressure?: LlmBoundaryTokenPressure | (() => LlmBoundaryTokenPressure);
  replay?: CompactionReplayPressureContext;
  requestContext?: Parameters<StreamFn>[1];
  fixedTokenPressure?: FixedRequestTokenPressure;
}): PreemptiveCompactionDecision {
  const estimateTranscriptPressure = (
    messages: AgentMessage[],
    replay?: CompactionReplayPressureContext,
    llmBoundaryTokenPressure?: typeof params.llmBoundaryTokenPressure,
  ) =>
    estimateTranscriptBoundaryTokenPressure({
      messages,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
      replay,
      llmBoundaryTokenPressure,
      requestContext: params.requestContext,
      fixedTokenPressure: params.fixedTokenPressure,
      ...(typeof params.toolSchemaTokens === "number"
        ? { toolSchemaTokens: params.toolSchemaTokens }
        : {}),
    });
  const transcriptTokenPressure = estimateTranscriptPressure(
    params.messages,
    params.replay,
    params.llmBoundaryTokenPressure,
  );
  const outgoingDecision = resolveCompactionPressureDecision(transcriptTokenPressure, params);
  let diagnosticDecision = outgoingDecision;
  if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
    const unwindowedTokenPressure = estimateTranscriptPressure(params.unwindowedMessages);
    // Unwindowed history is diagnostic: neither its checkpoints nor its larger
    // raw estimate may authorize recovery of a different outgoing window.
    if (unwindowedTokenPressure.estimatedPromptTokens > outgoingDecision.estimatedPromptTokens) {
      diagnosticDecision = resolveCompactionPressureDecision(
        {
          ...unwindowedTokenPressure,
          source: `unwindowed_${unwindowedTokenPressure.source}`,
        },
        params,
      );
    }
  }
  return {
    ...diagnosticDecision,
    ...(transcriptTokenPressure.hasCompactionReplay ? { compactionReplay: outgoingDecision } : {}),
  };
}

/** Price a request only after its caller has matched the measured predecessor. */
export function estimateProjectedRequestTokenPressure(params: {
  context: Parameters<StreamFn>[1];
  previousRequest?: MeasuredRequestContext;
  fixedTokenPressure?: FixedRequestTokenPressure;
}): LlmBoundaryTokenPressure {
  const { context, previousRequest } = params;
  const anchor = previousRequest && previousRequest.contextTokens > 0 ? previousRequest : undefined;
  const messages = context.messages;
  // Measured completion occupancy includes opaque reasoning. Its async fragments
  // share either identity; unrelated synthetic assistants remain fresh content.
  const appended = anchor
    ? messages
        .slice(anchor.messageCount)
        .filter(
          (message) =>
            message.role !== "assistant" ||
            !(
              (anchor.responseId && message.responseId?.trim() === anchor.responseId) ||
              (anchor.turnId && message.turnId?.trim() === anchor.turnId)
            ),
        )
    : messages;
  const estimate = createFreshLlmBoundaryTokenEstimator({
    ...(anchor
      ? {}
      : { ...context, retainCompletionUsage: true, fixedTokenPressure: params.fixedTokenPressure }),
    // Maintenance owns headroom; hard admission prices the request itself.
    safetyMargin: 1,
  });
  return {
    estimatedPromptTokens:
      (anchor?.contextTokens ?? 0) + estimate({ messages: appended, prompt: "" }),
    source: anchor ? "provider_context_usage" : "transcript_estimate",
  };
}

/** Price the projected foreground request; persisted usage alone cannot bind its prefix. */
export function resolveProjectedRequestPressure(params: {
  context: Parameters<StreamFn>[1];
  previousRequest?: MeasuredRequestContext;
  fixedTokenPressure?: FixedRequestTokenPressure;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
  replay?: CompactionReplayPressureContext;
}) {
  const { context, previousRequest } = params;
  const anchor = previousRequest && previousRequest.contextTokens > 0 ? previousRequest : undefined;
  const precheck = shouldPreemptivelyCompactBeforePrompt({
    ...params,
    messages: context.messages,
    requestContext: context,
    systemPrompt: context.systemPrompt,
    prompt: "",
    // A current-run anchor already includes any provider-owned compaction prefix.
    replay: anchor ? undefined : params.replay,
    llmBoundaryTokenPressure: () => estimateProjectedRequestTokenPressure(params),
  });
  return precheck.compactionReplay ?? precheck;
}

function resolveCompactionPressureDecision(
  pressure: Pick<TranscriptBoundaryTokenPressure, "messages" | "estimatedPromptTokens"> & {
    source: string;
  },
  params: { contextTokenBudget: number; reserveTokens: number; toolResultMaxChars?: number },
): CompactionPressureDecision {
  const { estimatedPromptTokens } = pressure;
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const effectiveReserveTokens = resolveEffectiveCompactionReserveTokens({
    contextTokenBudget,
    reserveTokens: params.reserveTokens,
  });
  const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultReducibleChars =
    overflowTokens > 0
      ? estimateToolResultReductionPotential({
          messages: pressure.messages,
          contextWindowTokens: params.contextTokenBudget,
          maxCharsOverride: params.toolResultMaxChars,
        }).maxReducibleChars
      : 0;
  const overflowChars = overflowTokens * CHARS_PER_TOKEN_ESTIMATE;
  const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
  const truncateOnlyThresholdChars = Math.max(
    overflowChars + truncationBufferChars,
    Math.ceil(overflowChars * 1.5),
  );

  // Choose truncate-only only when available reduction comfortably exceeds the overflow.
  const route: PreemptiveCompactionRoute =
    overflowTokens > 0
      ? toolResultReducibleChars <= 0
        ? "compact_only"
        : toolResultReducibleChars >= truncateOnlyThresholdChars
          ? "truncate_tool_results_only"
          : "compact_then_truncate"
      : "fits";
  return {
    route,
    shouldCompact: route === "compact_only" || route === "compact_then_truncate",
    estimatedPromptTokens,
    pressureSource: pressure.source,
    promptBudgetBeforeReserve,
    overflowTokens,
    toolResultReducibleChars,
    effectiveReserveTokens,
  };
}

export function formatPrePromptPrecheckLog(params: {
  result: PreemptiveCompactionDecision;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  modelId: string;
  messageCount: number;
  unwindowedMessageCount?: number;
  contextTokenBudget: number;
  reserveTokens: number;
  sessionFile?: string;
}): string {
  const { result } = params;
  return (
    `[context-overflow-precheck] pre-prompt check ` +
    `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"} ` +
    `provider=${params.provider}/${params.modelId} ` +
    `route=${result.route} ` +
    `estimatedPromptTokens=${result.estimatedPromptTokens} ` +
    `pressureSource=${result.pressureSource ?? "unknown"} ` +
    `promptBudgetBeforeReserve=${result.promptBudgetBeforeReserve} ` +
    `overflowTokens=${result.overflowTokens} ` +
    `toolResultReducibleChars=${result.toolResultReducibleChars} ` +
    `reserveTokens=${params.reserveTokens} ` +
    `effectiveReserveTokens=${result.effectiveReserveTokens} ` +
    `contextTokenBudget=${params.contextTokenBudget} ` +
    `messages=${params.messageCount} ` +
    `unwindowedMessages=${params.unwindowedMessageCount ?? params.messageCount} ` +
    `sessionFile=${params.sessionFile}`
  );
}

export function buildPrePromptContextBudgetStatus(params: {
  result: PreemptiveCompactionDecision;
  provider: string;
  modelId: string;
  messageCount: number;
  unwindowedMessageCount?: number;
  contextTokenBudget: number;
  reserveTokens: number;
  sessionId?: string;
  now?: number;
}): SessionContextBudgetStatus {
  const { result } = params;
  const remainingPromptBudgetTokens = Math.max(
    0,
    result.promptBudgetBeforeReserve - result.estimatedPromptTokens,
  );
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: params.now ?? Date.now(),
    provider: params.provider,
    model: params.modelId,
    route: result.route,
    shouldCompact: result.shouldCompact,
    estimatedPromptTokens: result.estimatedPromptTokens,
    contextTokenBudget: Math.max(1, Math.floor(params.contextTokenBudget)),
    promptBudgetBeforeReserve: result.promptBudgetBeforeReserve,
    reserveTokens: Math.max(0, Math.floor(params.reserveTokens)),
    effectiveReserveTokens: result.effectiveReserveTokens,
    remainingPromptBudgetTokens,
    overflowTokens: result.overflowTokens,
    toolResultReducibleChars: result.toolResultReducibleChars,
    messageCount: Math.max(0, Math.floor(params.messageCount)),
    unwindowedMessageCount: Math.max(
      0,
      Math.floor(params.unwindowedMessageCount ?? params.messageCount),
    ),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  };
}
