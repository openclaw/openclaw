import type { ModelTierMode } from "./model-tiers.js";

export type BrainAuthType = "oauth" | "apiKey" | "none";
export type BrainBillingType = "subscription" | "metered" | "local";

export type BrainProfile = {
  id: string;
  label: string;
  provider: string;
  model: string;
  auth: BrainAuthType;
  billing: BrainBillingType;
  modelRef: string;
  params?: Record<string, unknown>;
  fallbacks?: string[];
  allowMeteredFallback?: boolean;
  commercialSafe: boolean;
  notes?: string;
};

export type BrainTierRouting = Partial<Record<ModelTierMode, string>>;

export type BrainTierConfigParts = {
  globalMode?: ModelTierMode;
  agentOverrides?: Record<string, ModelTierMode>;
  tierRouting?: Record<string, unknown>;
  brainProfiles?: Record<string, unknown>;
};

export type NormalizedBrainTierConfig = {
  globalMode: ModelTierMode;
  agentOverrides: Record<string, ModelTierMode>;
  tierRouting: Required<Record<ModelTierMode, string>>;
  brainProfiles: Record<string, BrainProfile>;
};

export type BlockedBrainFallback = {
  profileId: string;
  modelRef: string;
  reason: "subscription_to_metered_blocked" | "unknown_profile";
};

export type ResolvedBrainProfile = {
  mode: ModelTierMode;
  profileId: string;
  modelRef: string;
  provider: string;
  model: string;
  auth: BrainAuthType;
  billing: BrainBillingType;
  commercialSafe: boolean;
  params: Record<string, unknown>;
  fallbacks: string[];
  blockedFallbacks: BlockedBrainFallback[];
  label: string;
};

export const DEFAULT_BRAIN_PROFILES: Record<string, BrainProfile> = {
  "openai-codex-subscription-best": {
    id: "openai-codex-subscription-best",
    label: "OpenAI Codex GPT-5.5",
    provider: "openai-codex",
    model: "gpt-5.5",
    auth: "oauth",
    billing: "subscription",
    modelRef: "openai-codex/gpt-5.5",
    params: { reasoning_effort: "high" },
    fallbacks: [],
    allowMeteredFallback: false,
    commercialSafe: false,
    notes: "Best personal operator mode when ChatGPT/Codex OAuth is available.",
  },
  "openai-api-balanced": {
    id: "openai-api-balanced",
    label: "OpenAI Balanced API",
    provider: "openai",
    model: "gpt-5.4",
    auth: "apiKey",
    billing: "metered",
    modelRef: "openai/gpt-5.4",
    params: { reasoning_effort: "medium" },
    fallbacks: [],
    allowMeteredFallback: true,
    commercialSafe: true,
    notes: "Commercial default candidate for Executive Mode.",
  },
  "openai-api-cheap": {
    id: "openai-api-cheap",
    label: "OpenAI Cheap API",
    provider: "openai",
    model: "gpt-5.4-mini",
    auth: "apiKey",
    billing: "metered",
    modelRef: "openai/gpt-5.4-mini",
    params: { reasoning_effort: "low" },
    fallbacks: [],
    allowMeteredFallback: true,
    commercialSafe: true,
    notes: "Commercial default candidate for Economy Mode.",
  },
  "local-economy": {
    id: "local-economy",
    label: "Local Economy Model",
    provider: "local-openai-compatible",
    model: "local-default",
    auth: "none",
    billing: "local",
    modelRef: "local-openai-compatible/local-default",
    params: {},
    fallbacks: [],
    allowMeteredFallback: false,
    commercialSafe: true,
    notes: "Reserved profile shape for Ollama, vLLM, LM Studio, or private OpenAI-compatible servers.",
  },
};

export const LEGACY_BRAIN_PROFILES: Record<string, BrainProfile> = {
  "legacy-anthropic-haiku": {
    id: "legacy-anthropic-haiku",
    label: "Legacy Anthropic Haiku",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    auth: "apiKey",
    billing: "metered",
    modelRef: "anthropic/claude-haiku-4-5-20251001",
    params: {},
    fallbacks: [],
    allowMeteredFallback: true,
    commercialSafe: true,
  },
  "legacy-anthropic-sonnet": {
    id: "legacy-anthropic-sonnet",
    label: "Legacy Anthropic Sonnet",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    auth: "apiKey",
    billing: "metered",
    modelRef: "anthropic/claude-sonnet-4-6",
    params: {},
    fallbacks: [],
    allowMeteredFallback: true,
    commercialSafe: true,
  },
  "legacy-anthropic-opus": {
    id: "legacy-anthropic-opus",
    label: "Legacy Anthropic Opus",
    provider: "anthropic",
    model: "claude-opus-4-6",
    auth: "apiKey",
    billing: "metered",
    modelRef: "anthropic/claude-opus-4-6",
    params: {},
    fallbacks: [],
    allowMeteredFallback: true,
    commercialSafe: true,
  },
};

export const LEGACY_TIER_ROUTING: Required<Record<ModelTierMode, string>> = {
  economy: "legacy-anthropic-haiku",
  baller: "legacy-anthropic-sonnet",
  einstein: "legacy-anthropic-opus",
};

const MODE_ORDER: readonly ModelTierMode[] = ["economy", "baller", "einstein"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAuthType(value: unknown): value is BrainAuthType {
  return value === "oauth" || value === "apiKey" || value === "none";
}

function isBillingType(value: unknown): value is BrainBillingType {
  return value === "subscription" || value === "metered" || value === "local";
}

function normalizeProfile(id: string, raw: unknown): BrainProfile | undefined {
  if (!isRecord(raw)) return undefined;
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const modelRef =
    typeof raw.modelRef === "string" && raw.modelRef.trim()
      ? raw.modelRef.trim()
      : provider && model
        ? `${provider}/${model}`
        : "";
  if (!id || !provider || !model || !modelRef) return undefined;
  if (!isAuthType(raw.auth) || !isBillingType(raw.billing)) return undefined;

  return {
    id,
    label,
    provider,
    model,
    auth: raw.auth,
    billing: raw.billing,
    modelRef,
    params: isRecord(raw.params) ? { ...raw.params } : {},
    fallbacks: Array.isArray(raw.fallbacks)
      ? raw.fallbacks.filter(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
        )
      : [],
    allowMeteredFallback: raw.allowMeteredFallback === true,
    commercialSafe: raw.commercialSafe === true,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
  };
}

export function normalizeBrainTierConfigParts(
  config: BrainTierConfigParts,
): NormalizedBrainTierConfig {
  const suppliedProfiles = isRecord(config.brainProfiles) ? config.brainProfiles : {};
  const brainProfiles: Record<string, BrainProfile> = {
    ...LEGACY_BRAIN_PROFILES,
    ...DEFAULT_BRAIN_PROFILES,
  };

  for (const [id, rawProfile] of Object.entries(suppliedProfiles)) {
    const normalized = normalizeProfile(id, rawProfile);
    if (normalized) {
      brainProfiles[id] = normalized;
    }
  }

  const configuredRouting = isRecord(config.tierRouting) ? config.tierRouting : {};
  const tierRouting = { ...LEGACY_TIER_ROUTING };
  for (const mode of MODE_ORDER) {
    const profileId = configuredRouting[mode];
    if (typeof profileId === "string" && brainProfiles[profileId]) {
      tierRouting[mode] = profileId;
    }
  }

  return {
    globalMode: config.globalMode ?? "economy",
    agentOverrides: { ...(config.agentOverrides ?? {}) },
    tierRouting,
    brainProfiles,
  };
}

export function resolveBrainProfileForMode(
  config: NormalizedBrainTierConfig,
  mode: ModelTierMode,
): ResolvedBrainProfile {
  const profileId = config.tierRouting[mode] ?? LEGACY_TIER_ROUTING[mode];
  const profile =
    config.brainProfiles[profileId] ??
    config.brainProfiles[LEGACY_TIER_ROUTING[mode]] ??
    LEGACY_BRAIN_PROFILES[LEGACY_TIER_ROUTING[mode]];
  const fallbacks: string[] = [];
  const blockedFallbacks: BlockedBrainFallback[] = [];

  for (const fallbackId of profile.fallbacks ?? []) {
    const fallback = config.brainProfiles[fallbackId];
    if (!fallback) {
      blockedFallbacks.push({ profileId: fallbackId, modelRef: "", reason: "unknown_profile" });
      continue;
    }
    if (
      profile.billing === "subscription" &&
      fallback.billing === "metered" &&
      profile.allowMeteredFallback !== true
    ) {
      blockedFallbacks.push({
        profileId: fallbackId,
        modelRef: fallback.modelRef,
        reason: "subscription_to_metered_blocked",
      });
      continue;
    }
    fallbacks.push(fallback.modelRef);
  }

  return {
    mode,
    profileId: profile.id,
    modelRef: profile.modelRef,
    provider: profile.provider,
    model: profile.model,
    auth: profile.auth,
    billing: profile.billing,
    commercialSafe: profile.commercialSafe,
    params: { ...(profile.params ?? {}) },
    fallbacks,
    blockedFallbacks,
    label: profile.label,
  };
}

export function resolveBrainProfileForAgent(
  config: NormalizedBrainTierConfig,
  agentId: string,
): ResolvedBrainProfile {
  const mode = config.agentOverrides[agentId] ?? config.globalMode;
  return resolveBrainProfileForMode(config, mode);
}
