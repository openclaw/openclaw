type ClaudeModelRef = {
  id?: string;
  params?: Record<string, unknown>;
};

function normalizeClaudeModelId(modelId?: string): string {
  const normalized = modelId?.trim().toLowerCase() ?? "";
  const unprefixed = normalized.startsWith("anthropic/")
    ? normalized.slice("anthropic/".length)
    : normalized;
  return unprefixed.replace(/[._\s]+/g, "-");
}

/** Resolve Claude Fable 5 through direct ids, cloud ids, or deployment metadata. */
export function resolveClaudeFable5ModelIdentity(ref: ClaudeModelRef): string | undefined {
  const configuredCanonicalModelId =
    typeof ref.params?.canonicalModelId === "string" ? ref.params.canonicalModelId : undefined;
  const normalized = normalizeClaudeModelId(configuredCanonicalModelId ?? ref.id);
  const match = /(?:^|-)claude-fable-5(?=$|-)/.exec(normalized);
  if (!match) {
    return undefined;
  }
  return normalized.slice((match.index ?? 0) + (match[0].startsWith("-") ? 1 : 0));
}
