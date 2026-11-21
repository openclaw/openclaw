type ClaudeModelRef = {
  id?: string;
  params?: Record<string, unknown>;
};

/**
 * Capabilities the provider's model listing advertised for this row, carried as
 * `params.claudeCapabilities`. Each listed flag overrides the model-id rules
 * below; rows without the record (or without one flag) keep the id rules.
 */
type ClaudeListedCapability =
  | "adaptiveThinking"
  | "disabledThinking"
  | "xhighEffort"
  | "maxEffort"
  | "serverCompaction";

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
  const modelId = (configuredCanonicalModelId ?? ref.id)?.trim().toLowerCase() ?? "";
  const unprefixed = modelId.startsWith("anthropic/")
    ? modelId.slice("anthropic/".length)
    : modelId;
  const normalized = unprefixed.replace(/[._\s]+/g, "-");
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
 * Canonical Claude id for contract checks, with bare family aliases expanded.
 * Undefined for ids that do not name a Claude model.
 */
function resolveClaudeContractId(ref: ClaudeModelRef): string | undefined {
  const identity = resolveClaudeModelIdentity(ref);
  if (identity.startsWith("claude-")) {
    return identity;
  }
  return (
    resolveClaudeOpus5ModelIdentity(ref) ??
    resolveClaudeSonnet5ModelIdentity(ref) ??
    resolveClaudeHaiku55ModelIdentity(ref)
  );
}

// Closed lists of released Claude generations that relax one strict default.
// They only ever shrink: a model Anthropic ships later is never added here, so
// it gets the strict contract until its /v1/models row says otherwise.
// `release("claude-opus-5")` matches claude-opus-5, its dated and cloud ids,
// but not a later minor version such as claude-opus-5-5.
function release(...ids: string[]): string {
  return String.raw`(?:${ids.join("|")})(?!-\d(?!\d))`;
}
function releases(...patterns: string[]): RegExp {
  return new RegExp(String.raw`(?:^|-)(?:${patterns.join("|")})(?=$|[^a-z0-9])`);
}
const PRE_CLAUDE_5 = String.raw`claude-(?:3|(?:opus|sonnet|haiku)-4)`;

/** Generations whose thinking survives edits to earlier turns (no prefix check). */
const CLAUDE_UNBOUND_THINKING = releases(
  PRE_CLAUDE_5,
  release("claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"),
  release("claude-mythos-preview"),
);

/** Generations that can run with thinking off (disabled or between-tools). */
const CLAUDE_OPTIONAL_THINKING = releases(
  PRE_CLAUDE_5,
  release("claude-opus-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5"),
);

/** Generations that predate adaptive thinking. */
const CLAUDE_WITHOUT_ADAPTIVE_THINKING = releases(
  String.raw`claude-(?:3|(?:opus|sonnet|haiku)-4(?:-[0-5](?!\d))?(?!-\d(?!\d)))`,
);

/** Generations that predate the Claude 5 request contract (refusal stop reasons, adaptive default). */
const CLAUDE_BEFORE_5_CONTRACT = releases(PRE_CLAUDE_5, release("claude-mythos-preview"));

/** Generations whose requests keep a trailing assistant prefill. */
const CLAUDE_ASSISTANT_PREFILL = releases(
  PRE_CLAUDE_5,
  release("claude-mythos-preview", "claude-fable-5", "claude-fable-5-1"),
  release("claude-mythos-5", "claude-mythos-5-1"),
);

/**
 * Released generations without native fast mode (`speed: "fast"`), verified live on
 * 2026-11-10: the API answers "does not support the `speed` parameter". Opus 4.6 accepts
 * the field but serves standard speed. Later models are offered fast mode; a rejection
 * falls back to standard speed and is remembered (see readUnsupportedClaudeFastModeModel).
 */
const CLAUDE_WITHOUT_FAST_MODE = releases(
  String.raw`claude-(?:3|haiku-4|sonnet-4|opus-4(?!-8(?!\d)))`,
  release("claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5"),
  release("claude-fable-5", "claude-fable-5-1"),
  release("claude-mythos-5", "claude-mythos-5-1", "claude-mythos-preview"),
);

/** Generations that still accept caller-selected temperature, top_p, and top_k. */
const CLAUDE_SAMPLING_PARAMETERS = releases(
  String.raw`claude-(?:3|haiku-4|sonnet-4|opus-4(?!-[78](?!\d)))`,
);

/**
 * Whether thinking blocks are valid only after the exact request prefix that
 * produced them, so runtime context must be appended instead of re-rendered.
 * Every Claude model is prefix-bound except the closed list of older generations.
 */
export function bindsClaudeThinkingPrefix(ref: ClaudeModelRef): boolean {
  const id = resolveClaudeContractId(ref);
  return id !== undefined && !CLAUDE_UNBOUND_THINKING.test(id);
}

/** Whether a Claude model follows the Claude 5 request contract (streamed refusals, adaptive by default). */
export function usesClaude5RequestContract(ref: ClaudeModelRef): boolean {
  const id = resolveClaudeContractId(ref);
  return id !== undefined && !CLAUDE_BEFORE_5_CONTRACT.test(id);
}

/** Whether a Claude model rejects a trailing assistant prefill. */
export function rejectsClaudeAssistantPrefill(ref: ClaudeModelRef): boolean {
  const id = resolveClaudeContractId(ref);
  return id !== undefined && !CLAUDE_ASSISTANT_PREFILL.test(id);
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
  const id = resolveClaudeContractId(ref);
  return id !== undefined && !CLAUDE_OPTIONAL_THINKING.test(id);
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

/**
 * Whether the id names a released Claude generation with adaptive thinking.
 * Unlike {@link supportsClaudeAdaptiveThinking}, unknown Claude ids answer false,
 * so providers can tell a released model from one they must map onto a template.
 */
export function isReleasedAdaptiveClaudeGeneration(ref: ClaudeModelRef): boolean {
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
  const listed = readListedClaudeCapability(ref, "adaptiveThinking");
  if (listed !== undefined) {
    return listed;
  }
  const id = resolveClaudeContractId(ref);
  return id !== undefined && !CLAUDE_WITHOUT_ADAPTIVE_THINKING.test(id);
}

/** Return whether a Claude model has a native 1M-token context window. */
export function supportsClaude1MContext(ref: ClaudeModelRef): boolean {
  // The id families currently coincide; listed thinking capabilities say nothing about context.
  return isReleasedAdaptiveClaudeGeneration(ref);
}

/** Return whether Anthropic documents threshold compaction (`compact_20260112`) for a Claude model. */
export function supportsClaudeServerCompaction(ref: ClaudeModelRef): boolean {
  // /v1/models lists context_management.compact_20260112 per model; unlisted
  // rows fall back to the released families that document it.
  return (
    readListedClaudeCapability(ref, "serverCompaction") ?? isReleasedAdaptiveClaudeGeneration(ref)
  );
}

/** Return whether a Claude model supports Anthropic's native fast mode. */
export function supportsClaudeFastMode(ref: ClaudeModelRef): boolean {
  const id = resolveClaudeContractId(ref);
  return id !== undefined && !CLAUDE_WITHOUT_FAST_MODE.test(id);
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
  const id = resolveClaudeContractId(ref);
  return id !== undefined && !CLAUDE_SAMPLING_PARAMETERS.test(id);
}

/**
 * Fill native Claude effort mappings only when the provider did not publish a
 * narrower route-specific contract.
 */
export function resolveClaudeNativeThinkingLevelMap(
  ref: ClaudeModelRef & {
    thinkingLevelMap?: Record<string, string | null | undefined>;
  },
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
