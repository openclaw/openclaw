export type AutoCompactionRetryHookResult =
  | { action: "proceed" }
  | { action: "proceed"; systemPrompt: string }
  | { action: "cancel"; errorMessage: string };

export type AutoCompactionRetryHookContextLike = {
  estimates: {
    messageTokens: number;
    systemPromptTokens: number;
    totalTokens: number;
    tokenBudget: number;
    overBy: number;
  };
};

type LoggerLike = {
  warn: (message: string) => void;
};

export function createAutoCompactionRetryHook(params: {
  getRetrySystemPrompt: () => string;
  onDowngradeSystemPrompt: () => void;
  logger: LoggerLike;
  logPrefix: string;
}): (ctx: AutoCompactionRetryHookContextLike) => AutoCompactionRetryHookResult {
  const SAFETY_MARGIN_TOKENS = 512;

  let cachedRetryPrompt: { text: string; tokens: number } | null = null;
  const getRetryPrompt = () => {
    if (cachedRetryPrompt) {
      return cachedRetryPrompt;
    }
    const retrySystemPrompt = params.getRetrySystemPrompt().trim();
    cachedRetryPrompt = {
      text: retrySystemPrompt,
      tokens: Math.ceil(retrySystemPrompt.length / 4),
    };
    return cachedRetryPrompt;
  };

  const cancelMessage =
    "Auto-compaction succeeded, but retry would still overflow due to system prompt size. " +
    "Try a larger-context model or reduce injected workspace files.";

  return (ctx) => {
    const safeBudget = Math.max(0, ctx.estimates.tokenBudget - SAFETY_MARGIN_TOKENS);

    // Fits already: keep the full system prompt.
    if (ctx.estimates.totalTokens <= safeBudget) {
      return { action: "proceed" };
    }

    const retryPrompt = getRetryPrompt();
    const totalSlim = ctx.estimates.messageTokens + retryPrompt.tokens;
    if (totalSlim <= safeBudget) {
      try {
        params.logger.warn(
          `${params.logPrefix} auto-compaction retry prompt downgraded: ` +
            `overBy=${ctx.estimates.overBy} tokenBudget=${ctx.estimates.tokenBudget} ` +
            `messageTokens=${ctx.estimates.messageTokens} ` +
            `systemPromptTokens=${ctx.estimates.systemPromptTokens} ` +
            `retrySystemPromptTokens=${retryPrompt.tokens}`,
        );
      } catch {
        // Best-effort logging - never block the downgrade.
      }
      try {
        params.onDowngradeSystemPrompt();
      } catch {
        // Best-effort side effect - still return the slim prompt for retry.
      }
      return { action: "proceed", systemPrompt: retryPrompt.text };
    }

    try {
      params.logger.warn(
        `${params.logPrefix} auto-compaction retry blocked: ` +
          `stillOverBy=${Math.max(0, totalSlim - safeBudget)} ` +
          `tokenBudget=${ctx.estimates.tokenBudget} messageTokens=${ctx.estimates.messageTokens} ` +
          `retrySystemPromptTokens=${retryPrompt.tokens}`,
      );
    } catch {
      // Best-effort logging.
    }
    return { action: "cancel", errorMessage: cancelMessage };
  };
}
