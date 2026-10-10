type ClaudeModelRef = {
  id?: string;
  params?: Record<string, unknown>;
};

type ClaudeEffortModelRef = ClaudeModelRef & {
  thinkingLevelMap?: Record<string, string | null | undefined>;
};

/**
 * Capabilities the provider's model listing advertised for this row, carried as
 * `params.claudeCapabilities`. Each listed flag overrides the model-id rules
 * below; rows without the record (or without one flag) keep the id rules.
 */
type ClaudeListedCapability = "adaptiveThinking" | "disabledThinking" | "xhighEffort" | "maxEffort";

function readListedClaudeCapability(
  ref: ClaudeModelRef,
  capability: ClaudeListedCapability,
): boolean | undefined {
  const listed = ref.params?.claudeCapabilities;
  if (typeof listed !== "object" || listed === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(listed, capability);
  return typeof value === "boolean" ? value : undefined;
}

function normalizeClaudeModelId(modelId?: string): string {
  const normalized = modelId?.trim().toLowerCase() ?? "";
  const unprefixed = normalized.startsWith("anthropic/")
    ? normalized.slice("anthropic/".length)
    : normalized;
  return unprefixed.replace(/[._\s]+/g, "-");
}

export const CLAUDE_FABLE_5_THINKING_PROFILE = {
  levels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
  defaultLevel: "medium",
  preserveWhenCatalogReasoningFalse: true,
} as const;

export const CLAUDE_SONNET_5_THINKING_PROFILE = {
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
} as const;

// Opus 5 shares Sonnet 5's surface: adaptive-by-default, full effort range,
// and thinking may still be disabled (at effort <= high), so "off" stays valid.
export const CLAUDE_OPUS_5_THINKING_PROFILE = CLAUDE_SONNET_5_THINKING_PROFILE;

export const CLAUDE_OPUS_55_THINKING_PROFILE = CLAUDE_FABLE_5_THINKING_PROFILE;

export const CLAUDE_SONNET_55_THINKING_PROFILE = {
  levels: [
    { id: "off" },
    { id: "low" },
    { id: "medium" },
    { id: "high" },
    { id: "xhigh" },
    { id: "max" },
  ],
  defaultLevel: "high",
} as const;

export const CLAUDE_HAIKU_55_THINKING_PROFILE = {
  ...CLAUDE_SONNET_55_THINKING_PROFILE,
  defaultLevel: "medium",
} as const;

/** Resolve Haiku 5.5 through direct ids, cloud ids, aliases, or deployment metadata. */
export function resolveClaudeHaiku55ModelIdentity(ref: ClaudeModelRef): string | undefined {
  const normalized = resolveClaudeModelIdentity(ref);
  if (normalized === "haiku" || normalized === "haiku-5-5") {
    return "claude-haiku-5-5";
  }
  return /^claude-haiku-5-5(?=$|[^a-z0-9])/.test(normalized) ? normalized : undefined;
}

/** Resolve the canonical normalized Claude model id for one runtime model ref. */
export function resolveClaudeModelIdentity(ref: ClaudeModelRef): string {
  const configuredCanonicalModelId =
    typeof ref.params?.canonicalModelId === "string" ? ref.params.canonicalModelId : undefined;
  const normalized = normalizeClaudeModelId(configuredCanonicalModelId ?? ref.id);
  // Routing namespaces can themselves start with "Claude"; only the final
  // path component identifies the backing model.
  const match = /(?:^|[-/])(claude-[^/]+)$/.exec(normalized);
  return match?.[1] ?? normalized;
}

function matchClaudeModelIdentity(normalized: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(normalized);
  return match ? normalized.slice(match.index + (match[0].startsWith("-") ? 1 : 0)) : undefined;
}

/** Resolve Claude Fable 5 through direct ids, cloud ids, or deployment metadata. */
export function resolveClaudeFable5ModelIdentity(ref: ClaudeModelRef): string | undefined {
  return matchClaudeModelIdentity(
    resolveClaudeModelIdentity(ref),
    /(?:^|-)claude-fable-5(?=$|[^a-z0-9])/,
  );
}

/** Resolve Claude Mythos 5 through direct ids, cloud ids, or deployment metadata. */
export function resolveClaudeMythos5ModelIdentity(ref: ClaudeModelRef): string | undefined {
  return matchClaudeModelIdentity(
    resolveClaudeModelIdentity(ref),
    /(?:^|-)claude-mythos-5(?=$|[^a-z0-9])/,
  );
}

/**
 * Opus 5.5, Sonnet 5.5, Haiku 5.5, and Fable 5.1 require append-only runtime context.
 * Extend only with live replay proof (Mythos 5.1 remains unproven).
 */
export function bindsClaudeThinkingPrefix(ref: ClaudeModelRef): boolean {
  return (
    resolveClaudeHaiku55ModelIdentity(ref) !== undefined ||
    resolveClaudeOpus55ModelIdentity(ref) !== undefined ||
    resolveClaudeSonnet55ModelIdentity(ref) !== undefined ||
    /^claude-fable-5-1(?=$|[^a-z0-9])/.test(resolveClaudeModelIdentity(ref))
  );
}

/** Return whether Claude accepts operator instructions within conversation history. */
export function supportsClaudeInHistorySystemMessages(ref: ClaudeModelRef): boolean {
  return (
    resolveClaudeHaiku55ModelIdentity(ref) !== undefined ||
    resolveClaudeOpus5ModelIdentity(ref) !== undefined ||
    resolveClaudeSonnet5ModelIdentity(ref) !== undefined ||
    resolveClaudeFable5ModelIdentity(ref) !== undefined ||
    resolveClaudeMythos5ModelIdentity(ref) !== undefined ||
    /^claude-opus-4-8(?=$|[^a-z0-9])/.test(resolveClaudeModelIdentity(ref))
  );
}

/** Return whether a Claude model requires adaptive thinking instead of manual budgets. */
export function requiresClaudeMandatoryAdaptiveThinking(ref: ClaudeModelRef): boolean {
  const disabledThinking = readListedClaudeCapability(ref, "disabledThinking");
  if (disabledThinking !== undefined) {
    // Sonnet 5.5 rejects disabled thinking but still has an off mode (between_tools).
    return (
      !disabledThinking &&
      !requiresClaudeBetweenToolsThinking(ref) &&
      supportsClaudeAdaptiveThinking(ref)
    );
  }
  const modelId = resolveClaudeModelIdentity(ref);
  return (
    resolveClaudeOpus55ModelIdentity(ref) !== undefined ||
    resolveClaudeFable5ModelIdentity(ref) !== undefined ||
    resolveClaudeMythos5ModelIdentity(ref) !== undefined ||
    /(?:^|-)claude-mythos-preview(?=$|[^a-z0-9])/.test(modelId)
  );
}

/** Resolve Claude Sonnet 5 through aliases, direct ids, cloud ids, or deployment metadata. */
export function resolveClaudeSonnet5ModelIdentity(ref: ClaudeModelRef): string | undefined {
  const normalized = resolveClaudeModelIdentity(ref);
  const sonnet55Identity = resolveClaudeSonnet55ModelIdentity(ref);
  if (sonnet55Identity) {
    return sonnet55Identity;
  }
  if (normalized === "sonnet-5") {
    return "claude-sonnet-5";
  }
  return matchClaudeModelIdentity(normalized, /(?:^|-)claude-sonnet-5(?=$|[^a-z0-9])/);
}

/** Resolve the Sonnet 5.5 contract without matching other Sonnet 5 generations. */
export function resolveClaudeSonnet55ModelIdentity(ref: ClaudeModelRef): string | undefined {
  const normalized = resolveClaudeModelIdentity(ref);
  if (normalized === "sonnet" || normalized === "sonnet-5-5") {
    return "claude-sonnet-5-5";
  }
  return /^claude-sonnet-5-5(?=$|[^a-z0-9])/.test(normalized) ? normalized : undefined;
}

/** Sonnet 5.5 replaces disabled thinking with between-tool progress updates. */
export function requiresClaudeBetweenToolsThinking(ref: ClaudeModelRef): boolean {
  return resolveClaudeSonnet55ModelIdentity(ref) !== undefined;
}

/** Resolve Claude Opus 5 through aliases, direct ids, cloud ids, or deployment metadata. */
export function resolveClaudeOpus5ModelIdentity(ref: ClaudeModelRef): string | undefined {
  const normalized = resolveClaudeModelIdentity(ref);
  const opus55Identity = resolveClaudeOpus55ModelIdentity(ref);
  if (opus55Identity) {
    return opus55Identity;
  }
  if (normalized === "opus" || normalized === "opus-5") {
    return "claude-opus-5";
  }
  return matchClaudeModelIdentity(normalized, /(?:^|-)claude-opus-5(?=$|[^a-z0-9])/);
}

/** Resolve the Opus 5.5 contract without matching other Opus 5 generations. */
export function resolveClaudeOpus55ModelIdentity(ref: ClaudeModelRef): string | undefined {
  const normalized = resolveClaudeModelIdentity(ref);
  if (normalized === "opus" || normalized === "opus-5-5") {
    return "claude-opus-5-5";
  }
  return /^claude-opus-5-5(?=$|[^a-z0-9])/.test(normalized) ? normalized : undefined;
}

function supportsClaudeAdaptiveThinkingById(ref: ClaudeModelRef): boolean {
  const modelId = resolveClaudeModelIdentity(ref);
  return (
    resolveClaudeHaiku55ModelIdentity(ref) !== undefined ||
    resolveClaudeOpus5ModelIdentity(ref) !== undefined ||
    resolveClaudeSonnet5ModelIdentity(ref) !== undefined ||
    /(?:^|-)claude-(?:fable-5|mythos-(?:5|preview)|opus-4-(?:6|7|8)|sonnet-4-6)(?=$|[^a-z0-9])/.test(
      modelId,
    )
  );
}

/** Return whether a Claude model supports adaptive thinking. */
export function supportsClaudeAdaptiveThinking(ref: ClaudeModelRef): boolean {
  return (
    readListedClaudeCapability(ref, "adaptiveThinking") ?? supportsClaudeAdaptiveThinkingById(ref)
  );
}

/** Return whether a Claude model has a native 1M-token context window. */
export function supportsClaude1MContext(ref: ClaudeModelRef): boolean {
  // The id families currently coincide; listed thinking capabilities say nothing about context.
  return supportsClaudeAdaptiveThinkingById(ref);
}

/** Return whether a Claude model supports Anthropic's native fast mode. */
export function supportsClaudeFastMode(ref: ClaudeModelRef): boolean {
  const modelId = resolveClaudeModelIdentity(ref);
  return (
    resolveClaudeOpus5ModelIdentity(ref) !== undefined ||
    /(?:^|-)claude-opus-4-8(?=$|[^a-z0-9])/.test(modelId)
  );
}

/** Return whether a Claude model supports native max effort. */
export function supportsClaudeNativeMaxEffort(ref: ClaudeModelRef): boolean {
  const listed = readListedClaudeCapability(ref, "maxEffort");
  if (listed !== undefined) {
    return listed;
  }
  const modelId = resolveClaudeModelIdentity(ref);
  return (
    resolveClaudeHaiku55ModelIdentity(ref) !== undefined ||
    resolveClaudeOpus5ModelIdentity(ref) !== undefined ||
    resolveClaudeSonnet5ModelIdentity(ref) !== undefined ||
    /(?:^|-)claude-(?:fable-5|mythos-5|opus-4-(?:6|7|8)|sonnet-4-6)(?=$|[^a-z0-9])/.test(modelId)
  );
}

/** Return whether a Claude model supports native xhigh effort. */
export function supportsClaudeNativeXhighEffort(ref: ClaudeModelRef): boolean {
  const listed = readListedClaudeCapability(ref, "xhighEffort");
  if (listed !== undefined) {
    return listed;
  }
  const modelId = resolveClaudeModelIdentity(ref);
  return (
    resolveClaudeHaiku55ModelIdentity(ref) !== undefined ||
    resolveClaudeOpus5ModelIdentity(ref) !== undefined ||
    resolveClaudeSonnet5ModelIdentity(ref) !== undefined ||
    /(?:^|-)claude-(?:fable-5|mythos-5|opus-4-(?:7|8))(?=$|[^a-z0-9])/.test(modelId)
  );
}

/** Return whether a Claude model rejects caller-selected sampling parameters. */
export function requiresClaudeDefaultSampling(ref: ClaudeModelRef): boolean {
  const modelId = resolveClaudeModelIdentity(ref);
  return (
    supportsClaudeNativeXhighEffort(ref) ||
    /(?:^|-)claude-mythos-preview(?=$|[^a-z0-9])/.test(modelId)
  );
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
