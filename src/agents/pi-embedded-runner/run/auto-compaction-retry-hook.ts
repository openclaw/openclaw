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
  retrySystemPrompt: string;
  onDowngradeSystemPrompt: () => void;
  logger: LoggerLike;
  logPrefix: string;
}): (ctx: AutoCompactionRetryHookContextLike) => AutoCompactionRetryHookResult {
  const retrySystemPrompt = params.retrySystemPrompt.trim();
  const retrySystemPromptTokens = Math.ceil(retrySystemPrompt.length / 4);

  const cancelMessage =
    "Auto-compaction succeeded, but retry would still overflow due to system prompt size. " +
    "Try a larger-context model or reduce injected workspace files.";

  return (ctx) => {
    // Fits already: keep the full system prompt.
    if (ctx.estimates.totalTokens <= ctx.estimates.tokenBudget) {
      return { action: "proceed" };
    }

    const totalSlim = ctx.estimates.messageTokens + retrySystemPromptTokens;
    if (totalSlim <= ctx.estimates.tokenBudget) {
      params.logger.warn(
        `${params.logPrefix} auto-compaction retry prompt downgraded: ` +
          `overBy=${ctx.estimates.overBy} tokenBudget=${ctx.estimates.tokenBudget} ` +
          `messageTokens=${ctx.estimates.messageTokens} ` +
          `systemPromptTokens=${ctx.estimates.systemPromptTokens} ` +
          `retrySystemPromptTokens=${retrySystemPromptTokens}`,
      );
      params.onDowngradeSystemPrompt();
      return { action: "proceed", systemPrompt: retrySystemPrompt };
    }

    params.logger.warn(
      `${params.logPrefix} auto-compaction retry blocked: ` +
        `stillOverBy=${Math.max(0, totalSlim - ctx.estimates.tokenBudget)} ` +
        `tokenBudget=${ctx.estimates.tokenBudget} messageTokens=${ctx.estimates.messageTokens} ` +
        `retrySystemPromptTokens=${retrySystemPromptTokens}`,
    );
    return { action: "cancel", errorMessage: cancelMessage };
  };
}
