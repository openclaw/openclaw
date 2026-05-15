export const MAX_TOKENS_PARAM_KEYS = ["maxTokens", "max_completion_tokens", "max_tokens"] as const;

type MaxTokensParamResolution = {
  seen: boolean;
  value: unknown;
};

function resolveMaxTokensParamValue(
  sources: Array<Record<string, unknown> | undefined>,
): MaxTokensParamResolution {
  let resolved: MaxTokensParamResolution = { seen: false, value: undefined };
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const key of MAX_TOKENS_PARAM_KEYS) {
      if (!Object.hasOwn(source, key)) {
        continue;
      }
      resolved = { seen: true, value: source[key] };
      break;
    }
  }
  return resolved;
}

export function resolveMaxTokensParam(
  sources: Array<Record<string, unknown> | undefined>,
): number | undefined {
  const resolved = resolveMaxTokensParamValue(sources);
  return typeof resolved.value === "number" ? resolved.value : undefined;
}

export function canonicalizeMaxTokensParam(params: {
  merged: Record<string, unknown>;
  sources: Array<Record<string, unknown> | undefined>;
}): void {
  const resolved = resolveMaxTokensParamValue(params.sources);
  if (!resolved.seen) {
    return;
  }
  for (const key of MAX_TOKENS_PARAM_KEYS) {
    delete params.merged[key];
  }
  if (typeof resolved.value === "number") {
    params.merged.maxTokens = resolved.value;
  }
}
