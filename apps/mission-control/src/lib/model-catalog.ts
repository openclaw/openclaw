/**
 * Curated model catalog with popularity, categorization, and display metadata.
 *
 * Sources (Feb 2026):
 *   - OpenRouter request volume rankings
 *   - LMSYS Chatbot Arena leaderboard
 *   - Artificial Analysis benchmarks
 *   - Provider pricing pages
 *
 * Update this file when new flagship models launch or popularity shifts.
 */

export type ModelTier = "popular" | "fast" | "reasoning" | "coding" | "budget";

export interface CatalogEntry {
  /** Model ID as used in APIs (without provider prefix). */
  id: string;
  /** Provider slug matching gateway provider names. */
  provider: string;
  /** Short human-friendly label. */
  label: string;
  /** UI badge (shown next to label). */
  badge?: string;
  /** Primary category for grouping in the dropdown. */
  tier: ModelTier;
  /** Sort weight within tier — lower = higher in list. */
  rank: number;
  /** True if this model is in the current generation (not deprecated). */
  current: boolean;
}

// ─── Tier labels for <optgroup> headers ───────────────────────
export const TIER_LABELS: Record<ModelTier, string> = {
  popular: "Popular",
  fast: "Fast & Efficient",
  reasoning: "Reasoning",
  coding: "Coding",
  budget: "Budget & Open Source",
};

/** Display order for tiers in the dropdown. */
export const TIER_ORDER: ModelTier[] = [
  "popular",
  "fast",
  "reasoning",
  "coding",
  "budget",
];

// ─── Curated catalog ──────────────────────────────────────────

export const MODEL_CATALOG: CatalogEntry[] = [
  // ── Popular (flagships & daily drivers) ──
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    label: "Claude Opus 4.6",
    badge: "Popular",
    tier: "popular",
    rank: 1,
    current: true,
  },
  {
    id: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    label: "Claude Sonnet 4.5",
    badge: "Popular",
    tier: "popular",
    rank: 2,
    current: true,
  },
  {
    id: "gpt-5.2",
    provider: "openai",
    label: "GPT-5.2",
    badge: "Popular",
    tier: "popular",
    rank: 3,
    current: true,
  },
  {
    id: "gpt-5.1",
    provider: "openai",
    label: "GPT-5.1",
    tier: "popular",
    rank: 4,
    current: true,
  },
  {
    id: "gemini-3-pro-preview",
    provider: "google",
    label: "Gemini 3 Pro",
    badge: "#1 Arena",
    tier: "popular",
    rank: 5,
    current: true,
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    label: "Gemini 2.5 Pro",
    tier: "popular",
    rank: 6,
    current: true,
  },
  {
    id: "grok-4",
    provider: "xai",
    label: "Grok 4",
    tier: "popular",
    rank: 7,
    current: true,
  },

  // ── Fast & Efficient ──
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    badge: "Fast",
    tier: "fast",
    rank: 1,
    current: true,
  },
  {
    id: "gemini-3-flash-preview",
    provider: "google",
    label: "Gemini 3 Flash",
    badge: "Fast",
    tier: "fast",
    rank: 2,
    current: true,
  },
  {
    id: "gpt-5-mini",
    provider: "openai",
    label: "GPT-5 Mini",
    badge: "Fast",
    tier: "fast",
    rank: 3,
    current: true,
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    label: "Gemini 2.5 Flash",
    tier: "fast",
    rank: 4,
    current: true,
  },
  {
    id: "gpt-5-nano",
    provider: "openai",
    label: "GPT-5 Nano",
    tier: "fast",
    rank: 5,
    current: true,
  },
  {
    id: "mistral-small-3-2-25-06",
    provider: "mistral",
    label: "Mistral Small 3.2",
    tier: "fast",
    rank: 6,
    current: true,
  },

  // ── Reasoning ──
  {
    id: "o3",
    provider: "openai",
    label: "o3",
    badge: "Reasoning",
    tier: "reasoning",
    rank: 1,
    current: true,
  },
  {
    id: "o3-mini",
    provider: "openai",
    label: "o3 Mini",
    tier: "reasoning",
    rank: 2,
    current: true,
  },
  {
    id: "deepseek-reasoner",
    provider: "deepseek",
    label: "DeepSeek R1",
    badge: "Value",
    tier: "reasoning",
    rank: 3,
    current: true,
  },

  // ── Coding ──
  {
    id: "devstral-2-25-12",
    provider: "mistral",
    label: "Devstral 2",
    badge: "Code",
    tier: "coding",
    rank: 1,
    current: true,
  },
  {
    id: "codestral-25-08",
    provider: "mistral",
    label: "Codestral",
    tier: "coding",
    rank: 2,
    current: true,
  },

  // ── Budget & Open Source ──
  {
    id: "deepseek-chat",
    provider: "deepseek",
    label: "DeepSeek V3",
    badge: "Best Value",
    tier: "budget",
    rank: 1,
    current: true,
  },
  {
    id: "meta-llama/llama-4-maverick",
    provider: "meta",
    label: "Llama 4 Maverick",
    tier: "budget",
    rank: 2,
    current: true,
  },
  {
    id: "meta-llama/llama-4-scout",
    provider: "meta",
    label: "Llama 4 Scout",
    badge: "10M ctx",
    tier: "budget",
    rank: 3,
    current: true,
  },

  // ── Still-popular legacy (kept for users who rely on them) ──
  {
    id: "gpt-4o",
    provider: "openai",
    label: "GPT-4o",
    badge: "Legacy",
    tier: "popular",
    rank: 90,
    current: false,
  },
  {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    label: "Claude Sonnet 4",
    badge: "Legacy",
    tier: "popular",
    rank: 91,
    current: false,
  },
];

// ─── Lookup helpers ───────────────────────────────────────────

const _byId = new Map<string, CatalogEntry>();
const _byProviderAndId = new Map<string, CatalogEntry>();

for (const entry of MODEL_CATALOG) {
  _byId.set(entry.id, entry);
  _byProviderAndId.set(`${entry.provider}/${entry.id}`, entry);
}

/**
 * Look up catalog metadata for a model.
 * Accepts bare id ("gpt-5.2") or provider-prefixed ("openai/gpt-5.2").
 */
export function catalogLookup(
  modelId: string,
  provider?: string
): CatalogEntry | undefined {
  if (provider) {
    const key = `${provider}/${modelId}`;
    if (_byProviderAndId.has(key)) {return _byProviderAndId.get(key);}
  }
  return _byId.get(modelId) ?? _byProviderAndId.get(modelId);
}

/**
 * Returns the curated models grouped by tier, sorted by rank.
 * Used as the default/fallback when the gateway model list is unavailable.
 */
export function getCuratedModelsByTier(): Record<ModelTier, CatalogEntry[]> {
  const grouped: Record<ModelTier, CatalogEntry[]> = {
    popular: [],
    fast: [],
    reasoning: [],
    coding: [],
    budget: [],
  };
  for (const entry of MODEL_CATALOG) {
    grouped[entry.tier].push(entry);
  }
  for (const tier of TIER_ORDER) {
    grouped[tier].sort((a, b) => a.rank - b.rank);
  }
  return grouped;
}
