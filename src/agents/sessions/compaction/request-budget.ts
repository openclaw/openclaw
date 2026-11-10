import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { SessionTreeEntry } from "../../../../packages/agent-core/src/harness/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { PromptOptions } from "../agent-session-types.js";
import {
  createFreshLlmBoundaryTokenEstimator,
  type FixedRequestTokenPressure,
} from "../context-token-pressure.js";
import type {
  CompactionRequestBudget,
  CompactionRequestConstraints,
} from "./request-budget.types.js";

const promptRequestBudgets = new WeakMap<PromptOptions, CompactionRequestBudget>();

function estimateVariableRequestTokens(messages: Iterable<AgentMessage>, prompt: string): number {
  const estimateTokens = createFreshLlmBoundaryTokenEstimator({});
  return estimateTokens({ messages, prompt }) - estimateTokens({ messages: [], prompt: "" });
}

/** Bind prepared foreground facts to the exact owned prompt invocation, outside public options. */
export function attachPromptCompactionRequestBudget(
  options: PromptOptions,
  budget: CompactionRequestBudget | undefined,
): void {
  if (budget) {
    promptRequestBudgets.set(options, budget);
  }
}

export function takePromptCompactionRequestBudget(
  options?: PromptOptions,
): CompactionRequestBudget | undefined {
  if (!options) {
    return undefined;
  }
  const budget = promptRequestBudgets.get(options);
  // Consume before preflight can handle, reject, or queue this prompt.
  promptRequestBudgets.delete(options);
  return budget;
}

export function createCompactionRequestBudget(params: {
  contextWindow: number;
  reserveTokens: number;
  systemPrompt?: string;
  tools?: readonly { name: string; description: string; parameters: unknown }[];
  fixedTokenPressure?: FixedRequestTokenPressure;
  pendingPrompt?: string;
  pendingImageCount?: number;
  pendingUserIdempotencyKey?: string;
  pendingContextMessages?: AgentMessage[];
  pendingQueuedContextMessages?: AgentMessage[];
  pendingAdditivePrompt?: string;
}): CompactionRequestBudget {
  const estimateTokens = createFreshLlmBoundaryTokenEstimator(params);
  const fixedTokens = estimateTokens({
    messages: [],
    prompt: "",
  });
  const pendingUserTokens =
    (params.pendingPrompt ?? "") === "" && (params.pendingImageCount ?? 0) === 0
      ? 0
      : estimateTokens({
          messages: [],
          prompt: params.pendingPrompt ?? "",
          imageCount: params.pendingImageCount,
        }) - fixedTokens;
  const pendingQueuedContextTokens = estimateCompactionHistoryTokens(
    params.pendingQueuedContextMessages ?? [],
  );
  const additionalContextTokens =
    estimateCompactionHistoryTokens(params.pendingContextMessages ?? []) +
    pendingQueuedContextTokens;
  const additiveTokens = params.pendingAdditivePrompt
    ? estimateVariableRequestTokens([], params.pendingAdditivePrompt)
    : 0;
  return {
    contextWindow: params.contextWindow,
    reserveTokens: params.reserveTokens,
    fixedTokens,
    pendingUserIdempotencyKey: params.pendingUserIdempotencyKey,
    pendingTokens: pendingUserTokens + additionalContextTokens,
    pendingQueuedContextTokens,
    ...(additionalContextTokens || additiveTokens
      ? { pendingUserTokens: Math.max(0, pendingUserTokens - additiveTokens) }
      : {}),
  };
}

/** Legacy standalone compaction relies on its fixed ceiling; opt-in growth needs a window budget. */
export function createStandaloneCompactionRequestBudget(
  params: Parameters<typeof createCompactionRequestBudget>[0] & { maxSummaryChars?: number },
): CompactionRequestBudget | undefined {
  return (params.maxSummaryChars ?? MAX_COMPACTION_SUMMARY_CHARS) > MAX_COMPACTION_SUMMARY_CHARS
    ? createCompactionRequestBudget(params)
    : undefined;
}

/** Reconcile only queued context; prepared user, image, and transient costs stay owned upstream. */
export function withCompactionQueuedContext(
  budget: CompactionRequestBudget,
  messages: AgentMessage[],
): CompactionRequestBudget {
  const pendingQueuedContextTokens = estimateCompactionHistoryTokens(messages);
  const previousQueuedTokens = budget.pendingQueuedContextTokens ?? 0;
  if (pendingQueuedContextTokens === previousQueuedTokens) {
    return budget;
  }
  return {
    ...budget,
    pendingTokens: budget.pendingTokens - previousQueuedTokens + pendingQueuedContextTokens,
    pendingQueuedContextTokens,
    // Newly queued context is never overlap credit for a recorded user.
    pendingUserTokens: budget.pendingUserTokens ?? budget.pendingTokens - previousQueuedTokens,
  };
}

export function estimateCompactionHistoryTokens(
  messages: Iterable<AgentMessage>,
  budget?: CompactionRequestBudget,
): number {
  let overlap = 0;
  function* observed() {
    for (const message of messages) {
      if (
        budget?.pendingTokens &&
        budget.pendingUserIdempotencyKey &&
        message.role === "user" &&
        "idempotencyKey" in message &&
        message.idempotencyKey === budget.pendingUserIdempotencyKey
      ) {
        overlap = Math.min(
          estimateVariableRequestTokens([message], ""),
          budget.pendingUserTokens ?? budget.pendingTokens,
        );
      }
      yield message;
    }
  }
  const total = estimateVariableRequestTokens(observed(), "");
  return total - overlap;
}

export function estimateCompactedRequestTokens(
  messages: Iterable<AgentMessage>,
  budget: CompactionRequestBudget,
): number {
  return (
    budget.fixedTokens + budget.pendingTokens + estimateCompactionHistoryTokens(messages, budget)
  );
}

export function assertCompactionRequestCanFit(
  messages: Iterable<AgentMessage>,
  budget: CompactionRequestBudget | undefined,
  hasCompactableHistory: boolean,
): void {
  // Try useful history reduction for pending input; only fixed overhead is unreclaimable here.
  if (budget && (!hasCompactableHistory || budget.fixedTokens > budget.contextWindow)) {
    const requestTokens = estimateCompactedRequestTokens(messages, budget);
    if (requestTokens > budget.contextWindow) {
      const historyTokens = requestTokens - budget.fixedTokens - budget.pendingTokens;
      throw new Error(
        `The estimated foreground request budget still exceeds the ${budget.contextWindow}-token model window ` +
          `(fixed instructions and tools: ${budget.fixedTokens}; pending input: ${budget.pendingTokens}; retained history: ${historyTokens}). ` +
          "No further history compaction can make this request fit. Use /context detail to reduce fixed context, shorten the request, or select a larger-context model.",
      );
    }
  }
}

export function resolveCompactionRetentionBudget(
  budget: CompactionRequestBudget,
  messages: Iterable<AgentMessage>,
  maxSummaryChars = MAX_COMPACTION_SUMMARY_CHARS,
) {
  const preferredTokens =
    budget.contextWindow - budget.reserveTokens - budget.fixedTokens - budget.pendingTokens;
  // Fixed prompt and pending input cannot be reclaimed. An approximate reserve
  // target must not prevent useful history reduction for an accepted request.
  const maxTokens =
    preferredTokens <= 0 ? estimateCompactionHistoryTokens(messages, budget) - 1 : preferredTokens;
  const summaryTokens = estimateCompactionHistoryTokens([
    {
      role: "compactionSummary",
      summary: "x".repeat(maxSummaryChars),
      tokensBefore: 0,
      timestamp: 0,
    },
  ]);
  return {
    // The legacy fallback can prefer useful reduction over fitting in one pass.
    // A raised artifact ceiling must not use that fallback to exceed the window.
    maxTokens:
      maxSummaryChars > MAX_COMPACTION_SUMMARY_CHARS
        ? Math.min(maxTokens, budget.contextWindow - budget.fixedTokens - budget.pendingTokens)
        : maxTokens,
    reserveTokens: summaryTokens,
  };
}

/** Locate the admitted pending request before choosing a compaction cut. */
export function resolveCompactionPendingEntryIndex(
  pathEntries: SessionTreeEntry[],
  constraints: CompactionRequestConstraints,
  pendingUserIdempotencyKey?: string,
): number {
  const pendingEntryIndex =
    constraints.pendingUserEntryId || pendingUserIdempotencyKey
      ? pathEntries.findLastIndex(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            (constraints.pendingUserEntryId
              ? entry.id === constraints.pendingUserEntryId
              : "idempotencyKey" in entry.message &&
                entry.message.idempotencyKey === pendingUserIdempotencyKey),
        )
      : -1;
  if (constraints.pendingUserEntryId && pendingEntryIndex < 0) {
    throw new Error("Compaction cannot find the admitted pending user request.");
  }
  return pendingEntryIndex;
}
