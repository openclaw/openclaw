/** Producer-side provenance for a run's prepared context budget. */
export type OuterContextTokenMeta = {
  contextTokens?: number;
  contextTokensSource?: "synthetic";
};

/**
 * A prepared budget carries synthetic provenance only when it is exactly the provider's
 * unknown-model estimate: no reported prompt limit, no authored cap, no caller budget.
 */
export function resolveOuterContextTokenMeta(
  runtimeModel: { contextWindow?: number; contextTokens?: number; contextWindowSource?: string },
  resolved: {
    contextTokenBudget?: number;
    authoredContextTokenCap?: number;
    contextWindowInfo?: { tokens: number; source: string };
  },
): OuterContextTokenMeta {
  if (resolved.contextTokenBudget === undefined) {
    return {};
  }
  const synthetic =
    runtimeModel.contextWindowSource === "synthetic" &&
    runtimeModel.contextTokens === undefined &&
    resolved.authoredContextTokenCap === undefined &&
    resolved.contextWindowInfo?.source === "model" &&
    resolved.contextTokenBudget === runtimeModel.contextWindow;
  return {
    contextTokens: resolved.contextTokenBudget,
    ...(synthetic ? { contextTokensSource: "synthetic" as const } : {}),
  };
}
