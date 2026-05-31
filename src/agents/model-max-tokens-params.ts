const MAX_TOKENS_PARAM_KEYS = ["maxTokens", "max_completion_tokens", "max_tokens"] as const;

/**
 * Accepts only finite, non-negative numeric token limits from untyped provider
 * parameter bags.
 */
export function resolveNonNegativeMaxTokensParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Reads max-token limits from the supported OpenClaw and provider alias keys,
 * returning the first valid value in canonical precedence order.
 */
export function resolveMaxTokensParam(
  params: Record<string, unknown> | undefined,
): number | undefined {
  if (!params) {
    return undefined;
  }
  for (const key of MAX_TOKENS_PARAM_KEYS) {
    const resolved = resolveNonNegativeMaxTokensParam(params[key]);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

/**
 * Collapses max-token aliases across layered parameter sources into the SDK
 * `maxTokens` field so downstream model calls never see conflicting keys.
 */
export function canonicalizeMaxTokensParam(params: {
  merged: Record<string, unknown>;
  sources: Array<Record<string, unknown> | undefined>;
}): void {
  let resolved: number | undefined;
  for (const source of params.sources) {
    const sourceValue = resolveMaxTokensParam(source);
    if (sourceValue !== undefined) {
      resolved = sourceValue;
    }
  }
  if (resolved === undefined) {
    return;
  }
  for (const key of MAX_TOKENS_PARAM_KEYS) {
    delete params.merged[key];
  }
  params.merged.maxTokens = resolved;
}
