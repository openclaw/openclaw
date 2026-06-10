type ClaudeModelRef = {
  id?: string;
  params?: Record<string, unknown>;
};

type ClaudeEffortModelRef = ClaudeModelRef & {
  thinkingLevelMap?: Record<string, string | null | undefined>;
};

function normalizeClaudeModelId(modelId?: string): string {
  const normalized = modelId?.trim().toLowerCase() ?? "";
  const unprefixed = normalized.startsWith("anthropic/")
    ? normalized.slice("anthropic/".length)
    : normalized;
  return unprefixed.replace(/[._\s]+/g, "-");
}

export const CLAUDE_FABLE_5_THINKING_PROFILE = {
  levels: [
    { id: "off" },
    { id: "minimal" },
    { id: "low" },
    { id: "medium" },
    { id: "high" },
    { id: "xhigh" },
    { id: "adaptive" },
    { id: "max" },
  ],
  defaultLevel: "high",
  preserveWhenCatalogReasoningFalse: true,
} as const;

/** Resolve the canonical normalized Claude model id for one runtime model ref. */
export function resolveClaudeModelIdentity(ref: ClaudeModelRef): string {
  const configuredCanonicalModelId =
    typeof ref.params?.canonicalModelId === "string" ? ref.params.canonicalModelId : undefined;
  const normalized = normalizeClaudeModelId(configuredCanonicalModelId ?? ref.id);
  const match = /(?:^|[-/])claude-/.exec(normalized);
  return match
    ? normalized.slice((match.index ?? 0) + (match[0].startsWith("claude-") ? 0 : 1))
    : normalized;
}

/** Resolve Claude Fable 5 through direct ids, cloud ids, or deployment metadata. */
export function resolveClaudeFable5ModelIdentity(ref: ClaudeModelRef): string | undefined {
  const normalized = resolveClaudeModelIdentity(ref);
  const match = /(?:^|-)claude-fable-5(?=$|[^a-z0-9])/.exec(normalized);
  if (!match) {
    return undefined;
  }
  return normalized.slice((match.index ?? 0) + (match[0].startsWith("-") ? 1 : 0));
}

/** Return whether a Claude model supports adaptive thinking. */
export function supportsClaudeAdaptiveThinking(ref: ClaudeModelRef): boolean {
  const modelId = resolveClaudeModelIdentity(ref);
  return /(?:^|-)claude-(?:fable-5|opus-4-(?:6|7|8)|sonnet-4-6)(?=$|[^a-z0-9])/.test(modelId);
}

/** Return whether a Claude model supports native max effort. */
export function supportsClaudeNativeMaxEffort(ref: ClaudeModelRef): boolean {
  return supportsClaudeAdaptiveThinking(ref);
}

/** Return whether a Claude model supports native xhigh effort. */
export function supportsClaudeNativeXhighEffort(ref: ClaudeModelRef): boolean {
  const modelId = resolveClaudeModelIdentity(ref);
  return /(?:^|-)claude-(?:fable-5|opus-4-(?:7|8))(?=$|[^a-z0-9])/.test(modelId);
}

/**
 * Fill native Claude effort mappings only when the provider did not publish a
 * narrower route-specific contract.
 */
export function resolveClaudeNativeThinkingLevelMap(
  ref: ClaudeEffortModelRef,
): Record<string, string | null | undefined> | undefined {
  if (ref.thinkingLevelMap !== undefined) {
    return ref.thinkingLevelMap;
  }
  if (!supportsClaudeNativeMaxEffort(ref)) {
    return undefined;
  }
  return {
    xhigh: supportsClaudeNativeXhighEffort(ref) ? "xhigh" : null,
    max: "max",
  };
}
