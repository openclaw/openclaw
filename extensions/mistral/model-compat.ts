const MISTRAL_MAX_TOKENS_FIELD = "max_tokens";

export function applyMistralModelCompat<T extends { compat?: unknown }>(model: T): T {
  const patch = {
    supportsStore: false,
    supportsReasoningEffort: false,
    maxTokensField: MISTRAL_MAX_TOKENS_FIELD,
  } satisfies Record<string, unknown>;
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as Record<string, unknown>)
      : undefined;
  if (compat && Object.entries(patch).every(([key, value]) => compat[key] === value)) {
    return model;
  }
  return {
    ...model,
    compat: {
      ...compat,
      ...patch,
    } as T extends { compat?: infer TCompat } ? TCompat : never,
  } as T;
}
