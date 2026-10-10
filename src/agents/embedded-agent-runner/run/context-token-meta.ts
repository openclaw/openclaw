import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";

/** Producer-side provenance for a run's prepared context budget. */
export type OuterContextTokenMeta = {
  contextTokens?: number;
  contextTokensSource?: "synthetic" | "resolved-v1";
};

/**
 * A prepared budget carries synthetic provenance only when it is exactly the provider's
 * unknown-model estimate: no reported prompt limit, no authored cap, no caller budget.
 */
export function resolveOuterContextTokenMeta(
  runtimeModel: Partial<
    Pick<
      ProviderRuntimeModel,
      "contextWindow" | "contextTokens" | "contextWindowSource" | "contextWindows"
    >
  >,
  resolved: {
    contextTokenBudget?: number;
    authoredContextTokenCap?: number;
    contextWindowInfo?: { tokens: number; source: string; referenceTokens?: number };
  },
): OuterContextTokenMeta {
  if (resolved.contextTokenBudget === undefined) {
    return {};
  }
  const uncapped =
    resolved.authoredContextTokenCap === undefined &&
    resolved.contextWindowInfo?.referenceTokens === undefined &&
    !runtimeModel.contextWindows?.length;
  const synthetic =
    uncapped &&
    runtimeModel.contextWindowSource === "synthetic" &&
    runtimeModel.contextTokens === undefined &&
    (resolved.contextWindowInfo?.source === "model" ||
      resolved.contextWindowInfo?.source === "default") &&
    resolved.contextTokenBudget === runtimeModel.contextWindow;
  // Cold readers may reuse only uncapped model-owned limits. Authored caps
  // can be removed, and selectable windows require a selection absent from
  // the persisted producer tuple.
  const verified =
    uncapped &&
    resolved.contextWindowInfo?.source === "model" &&
    (runtimeModel.contextWindowSource !== "synthetic" ||
      runtimeModel.contextTokens === resolved.contextTokenBudget);
  return {
    contextTokens: resolved.contextTokenBudget,
    ...(synthetic
      ? { contextTokensSource: "synthetic" as const }
      : verified
        ? { contextTokensSource: "resolved-v1" as const }
        : {}),
  };
}
