/** Effect-free compaction accounting, shared with worker-local replay preparation. */
import type { AgentMessage } from "../runtime/index.js";
import type { CompactionRequestBudget } from "../sessions/compaction/preparation.types.js";
import { estimateCompactedRequestTokens } from "../sessions/compaction/request-budget.js";
import type { BeforeCompactionHookMetrics } from "./compaction-hook-metrics.types.js";

export function estimateCompactionMessageTokens(
  messages: AgentMessage[],
  estimateTokensFn: (message: AgentMessage) => number,
): number | undefined {
  try {
    let total = 0;
    for (const message of messages) {
      total += estimateTokensFn(message);
    }
    return total;
  } catch {
    return undefined;
  }
}

/** Builds before-hook metrics while tolerating providers that cannot estimate all messages. */
export function buildBeforeCompactionHookMetrics(params: {
  originalMessages: AgentMessage[];
  currentMessages: AgentMessage[];
  observedTokenCount?: number;
  estimateTokensFn: (message: AgentMessage) => number;
}): BeforeCompactionHookMetrics {
  return {
    messageCountOriginal: params.originalMessages.length,
    tokenCountOriginal: estimateCompactionMessageTokens(
      params.originalMessages,
      params.estimateTokensFn,
    ),
    messageCountBefore: params.currentMessages.length,
    tokenCountBefore:
      params.observedTokenCount ??
      estimateCompactionMessageTokens(params.currentMessages, params.estimateTokensFn),
  };
}

/** Estimates compacted-session token count and rejects impossible growth from stale estimates. */
export function estimateTokensAfterCompaction(
  params: {
    observedTokenCount?: number;
    fullSessionTokensBefore: number;
    requestBudget?: CompactionRequestBudget;
  } & (
    | {
        messagesAfter: AgentMessage[];
        estimateTokensFn: (message: AgentMessage) => number;
      }
    | { estimatedTokensAfter: number | undefined }
  ),
) {
  const tokensAfter =
    "estimatedTokensAfter" in params
      ? params.estimatedTokensAfter
      : params.requestBudget
        ? estimateCompactedRequestTokens(params.messagesAfter, {
            ...params.requestBudget,
            pendingTokens: 0,
          })
        : estimateCompactionMessageTokens(params.messagesAfter, params.estimateTokensFn);
  if (tokensAfter === undefined || params.requestBudget) {
    return tokensAfter;
  }
  const sanityCheckBaseline = params.observedTokenCount ?? params.fullSessionTokensBefore;
  return sanityCheckBaseline > 0 &&
    tokensAfter >
      (params.observedTokenCount !== undefined ? sanityCheckBaseline : sanityCheckBaseline * 1.1)
    ? undefined
    : tokensAfter;
}
