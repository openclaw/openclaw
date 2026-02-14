/**
 * Automatic model selection for agents based on role requirements.
 *
 * Discovers available models from the catalog, classifies them by cost/capability/recency,
 * and selects the cheapest + newest model that meets each agent role's requirements.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { AgentRole } from "../config/types.agents.js";
import type {
  CostTier,
  ModelCapabilities,
  ModelCapability,
  PerformanceTier,
} from "./model-capabilities.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import type { ModelRef } from "./model-selection.js";
import {
  ensureAuthProfileStore,
  isProfileInCooldown,
  resolveAuthProfileOrder,
  type AuthProfileStore,
} from "./auth-profiles.js";
import { getModelCapabilitiesFromCatalog } from "./model-capabilities.js";
import { isLatestModel } from "./model-catalog.js";
import { isModelCoolingDown } from "./model-fallback.js";
import { modelKey } from "./model-selection.js";
import { classifyComplexity } from "./task-classifier.js";

// ── Cost/performance tier ordinals for comparison ──

export const COST_TIER_ORDER: Record<CostTier, number> = {
  free: 0,
  cheap: 1,
  moderate: 2,
  expensive: 3,
};

const PERF_TIER_ORDER: Record<PerformanceTier, number> = {
  fast: 0,
  balanced: 1,
  powerful: 2,
};

// ── Role requirements ──

export type RoleRequirements = {
  /** Minimum performance tier the model must meet. */
  minPerformanceTier: PerformanceTier;
  /** Capabilities the model MUST have (all required). */
  requiredCapabilities: ModelCapability[];
  /** Maximum cost tier allowed for this role. */
  maxCostTier: CostTier;
};

/**
 * Default requirements per agent role.
 * Orchestrators need reasoning+coding at any cost.
 * Workers only need general capability at cheap/free cost.
 */
export const ROLE_REQUIREMENTS: Record<AgentRole, RoleRequirements> = {
  orchestrator: {
    minPerformanceTier: "balanced",
    requiredCapabilities: ["coding", "reasoning"],
    maxCostTier: "expensive",
  },
  lead: {
    minPerformanceTier: "balanced",
    requiredCapabilities: ["coding"],
    maxCostTier: "moderate",
  },
  specialist: {
    minPerformanceTier: "fast",
    requiredCapabilities: ["coding"],
    maxCostTier: "moderate",
  },
  worker: {
    minPerformanceTier: "fast",
    requiredCapabilities: [],
    maxCostTier: "cheap",
  },
};

// ── Model version heuristic for recency scoring ──

/**
 * Extract a numeric version score from a model ID for recency comparison.
 * Higher score = more recent. Uses pattern matching on common version schemes.
 *
 * Examples:
 *   claude-opus-4-6 → 46
 *   gpt-5.2 → 52
 *   gemini-2.0-flash → 20
 *   llama-3.3-70b → 33
 */
export function extractVersionScore(modelId: string): number {
  const lower = modelId.toLowerCase();

  // claude-opus-4-6, claude-sonnet-4-5, claude-3-5-haiku → extract digit-digit pair
  const claudeMatch = lower.match(/claude-.*?(\d+)-(\d+)/);
  if (claudeMatch) {
    return Number(claudeMatch[1]) * 10 + Number(claudeMatch[2]);
  }

  // gpt-5.2, gpt-4.1 → major.minor as 2-digit
  const gptMatch = lower.match(/gpt-(\d+)\.(\d+)/);
  if (gptMatch) {
    return Number(gptMatch[1]) * 10 + Number(gptMatch[2]);
  }

  // gpt-oss-120b -> treat as equivalent to GPT-4 level (40) or explicit score?
  if (lower.includes("gpt-oss")) {
    return 45; // Treat as high-end open source
  }

  // gpt-5, gpt-4 → major only
  const gptMajorMatch = lower.match(/gpt-(\d+)(?![\d.])/);
  if (gptMajorMatch) {
    return Number(gptMajorMatch[1]) * 10;
  }

  // o4-mini, o3 → reasoning series
  const oMatch = lower.match(/^o(\d+)/);
  if (oMatch) {
    return Number(oMatch[1]) * 10;
  }

  // gemini-3-flash, gemini-2.0-flash → major.minor
  const geminiMatch = lower.match(/gemini-(\d+)(?:\.(\d+))?/);
  if (geminiMatch) {
    return Number(geminiMatch[1]) * 10 + Number(geminiMatch[2] ?? 0);
  }

  // llama-3.3-70b → major.minor
  const llamaMatch = lower.match(/llama[_-]?(\d+)(?:\.(\d+))?/);
  if (llamaMatch) {
    return Number(llamaMatch[1]) * 10 + Number(llamaMatch[2] ?? 0);
  }

  // mistral-large, codestral → no version, low recency
  return 0;
}

export function isLegacyModelIdForAutoSelection(modelId: string): boolean {
  const lower = modelId.toLowerCase();

  // OpenAI: discard entire GPT-3.5 and GPT-4 families (GPT-5+ is current).
  if (/\bgpt-3\.5\b/.test(lower) || lower.startsWith("gpt-3.5")) {
    return true;
  }
  if (/\bgpt-4/.test(lower)) {
    return true;
  }

  // OpenAI O-series: older generations (o1, o2, o3).
  if (/^o[1-3]\b/.test(lower)) {
    return true;
  }

  // Anthropic: discard Claude 2/Instant and all Claude 3.x including 3.5 (Claude 4.x+ is current).
  if (/\bclaude-(?:instant|2)\b/.test(lower)) {
    return true;
  }
  if (lower.startsWith("claude-3")) {
    return true;
  }

  // Google: discard Gemini 1.x (keep 2.0+ as current).
  if (/\bgemini-1\b/.test(lower) || /\bgemini-1\./.test(lower)) {
    return true;
  }

  return false;
}

// ── Model scoring ──

export type ScoredModel = {
  entry: ModelCatalogEntry;
  capabilities: ModelCapabilities;
  costScore: number;
  versionScore: number;
};

/**
 * Check if a model meets the given role requirements.
 */
export function meetsRequirements(
  capabilities: ModelCapabilities,
  requirements: RoleRequirements,
): boolean {
  // Check performance tier minimum
  if (
    PERF_TIER_ORDER[capabilities.performanceTier] < PERF_TIER_ORDER[requirements.minPerformanceTier]
  ) {
    return false;
  }

  // Check cost tier maximum
  if (COST_TIER_ORDER[capabilities.costTier] > COST_TIER_ORDER[requirements.maxCostTier]) {
    return false;
  }

  // Check all required capabilities
  for (const cap of requirements.requiredCapabilities) {
    if (!capabilities[cap]) {
      return false;
    }
  }

  return true;
}

/**
 * Score and rank qualifying models for a role.
 * Returns models sorted by: cost (cheapest first), then version (newest first).
 * This matches the "cheapest that meets requirements" goal while still preferring
 * newer releases when the cost tier is the same.
 */
export function rankModelsForRole(
  catalog: ModelCatalogEntry[],
  requirements: RoleRequirements,
  allowedKeys?: Set<string>,
  cfg?: OpenClawConfig,
  authStore?: AuthProfileStore,
): ScoredModel[] {
  const scored: ScoredModel[] = [];

  for (const entry of catalog) {
    // Skip dated snapshots — prefer canonical/latest versions
    if (!isLatestModel(entry)) {
      continue;
    }

    // Skip legacy models (auto-selection should prefer modern/cheap defaults).
    if (isLegacyModelIdForAutoSelection(entry.id)) {
      continue;
    }

    // Skip models not in the allowlist (if provided)
    if (allowedKeys && !allowedKeys.has(modelKey(entry.provider, entry.id))) {
      continue;
    }

    // Skip models whose provider is in cooldown (all profiles unavailable)
    if (authStore && cfg) {
      const profileIds = resolveAuthProfileOrder({
        cfg,
        store: authStore,
        provider: entry.provider,
      });
      // If we have profiles, and ALL of them are in cooldown, skip this model.
      if (profileIds.length > 0 && profileIds.every((id) => isProfileInCooldown(authStore, id))) {
        continue;
      }
    }

    // Skip models that are individually in cooldown (e.g. rate-limited specific model)
    if (isModelCoolingDown({ provider: entry.provider, model: entry.id })) {
      continue;
    }

    const capabilities = getModelCapabilitiesFromCatalog(entry);
    if (!meetsRequirements(capabilities, requirements)) {
      // console.log("Skipping reqs", entry.id);
      continue;
    }

    const scoredModel = {
      entry,
      capabilities,
      costScore: COST_TIER_ORDER[capabilities.costTier],
      versionScore: extractVersionScore(entry.id),
    };
    // console.log("Scored:", entry.id, scoredModel.costScore, scoredModel.versionScore);
    scored.push(scoredModel);
  }

  // Sort: cheapest first (ascending cost), then newest first (descending version) as tiebreaker
  scored.sort((a, b) => {
    const costDiff = a.costScore - b.costScore;
    if (costDiff !== 0) {
      return costDiff;
    }
    return b.versionScore - a.versionScore;
  });

  return scored;
}

/**
 * Select the optimal model for a given agent role from the catalog.
 * Returns the cheapest + newest model that meets the role's requirements.
 * If no model qualifies, relaxes cost constraint and tries again.
 */
export function selectModelForRole(
  catalog: ModelCatalogEntry[],
  role: AgentRole,
  allowedKeys?: Set<string>,
  cfg?: OpenClawConfig,
  authStore?: AuthProfileStore,
): ModelRef | null {
  const requirements = ROLE_REQUIREMENTS[role];

  // First pass: strict requirements
  const ranked = rankModelsForRole(catalog, requirements, allowedKeys, cfg, authStore);
  if (ranked.length > 0) {
    const best = ranked[0];
    return { provider: best.entry.provider, model: best.entry.id };
  }

  // Second pass: relax cost constraint to "expensive" (allow any cost)
  if (requirements.maxCostTier !== "expensive") {
    const relaxed: RoleRequirements = {
      ...requirements,
      maxCostTier: "expensive",
    };
    const relaxedRanked = rankModelsForRole(catalog, relaxed, allowedKeys, cfg, authStore);
    if (relaxedRanked.length > 0) {
      const best = relaxedRanked[0];
      return { provider: best.entry.provider, model: best.entry.id };
    }
  }

  // Third pass: relax performance tier to "fast" (allow any performance)
  const fullyRelaxed: RoleRequirements = {
    minPerformanceTier: "fast",
    requiredCapabilities: [],
    maxCostTier: "expensive",
  };
  const fullyRelaxedRanked = rankModelsForRole(catalog, fullyRelaxed, allowedKeys, cfg, authStore);
  if (fullyRelaxedRanked.length > 0) {
    const best = fullyRelaxedRanked[0];
    return { provider: best.entry.provider, model: best.entry.id };
  }

  return null;
}

/**
 * Compute optimal model selections for all agent roles.
 * Returns a map of role → ModelRef.
 */
export function computeAutoSelections(
  catalog: ModelCatalogEntry[],
  allowedKeys?: Set<string>,
  cfg?: OpenClawConfig,
  authStore?: AuthProfileStore,
): Map<AgentRole, ModelRef> {
  const selections = new Map<AgentRole, ModelRef>();
  const roles: AgentRole[] = ["orchestrator", "lead", "specialist", "worker"];

  for (const role of roles) {
    const selected = selectModelForRole(catalog, role, allowedKeys, cfg, authStore);
    if (selected) {
      selections.set(role, selected);
    }
  }

  return selections;
}

// ── Cached auto-selection state ──

let cachedSelections: Map<AgentRole, ModelRef> | null = null;
let cachedCatalog: ModelCatalogEntry[] | null = null;
let cachedAllowedKeys: Set<string> | undefined;
let cachedCfg: OpenClawConfig | undefined;

/**
 * Initialize the auto-model-selection cache from the catalog.
 * Call this at gateway startup after loading the model catalog.
 * Logs the selected models for each role.
 */
export function initAutoModelSelection(
  catalog: ModelCatalogEntry[],
  allowedKeys?: Set<string>,
  cfg?: OpenClawConfig,
): void {
  // Load auth store to filter out cooldown providers
  const authStore = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });

  cachedCatalog = catalog;
  cachedAllowedKeys = allowedKeys;
  cachedCfg = cfg;
  cachedSelections = computeAutoSelections(catalog, allowedKeys, cfg, authStore);

  if (cachedSelections.size > 0) {
    const lines = Array.from(cachedSelections.entries())
      .map(([role, ref]) => `  ${role}: ${ref.provider}/${ref.model}`)
      .join("\n");
    console.log(`[model-auto-select] Auto-selected models by role:\n${lines}`);
  }
}

/**
 * Get the auto-selected model for a given agent role.
 * Returns null if auto-selection hasn't been initialized or no model qualifies.
 */
export function getAutoSelectedModel(role: AgentRole): ModelRef | null {
  return cachedSelections?.get(role) ?? null;
}

/**
 * Get the auto-selected model for a task+role pair using adaptive routing.
 * Falls back to role-based selection when adaptive routing fails or catalog is unavailable.
 *
 * Uses synchronous import since adaptive-routing has no circular dependency at runtime.
 */
export function getAutoSelectedModelForTask(
  task: string,
  role: AgentRole,
): { ref: ModelRef; complexity: string; downgraded: boolean } | null {
  if (!cachedCatalog || cachedCatalog.length === 0) {
    const ref = cachedSelections?.get(role) ?? null;
    return ref ? { ref, complexity: "moderate", downgraded: false } : null;
  }

  const authStore = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });

  const result = selectModelForTaskFromCatalog({
    task,
    role,
    catalog: cachedCatalog,
    allowedKeys: cachedAllowedKeys,
    cfg: cachedCfg,
    authStore,
  });

  if (result) {
    return result;
  }

  // Fallback to role-based selection.
  const ref = cachedSelections?.get(role) ?? null;
  return ref ? { ref, complexity: "moderate", downgraded: false } : null;
}

/**
 * Internal: select model for task using the catalog directly.
 * Inlined to avoid circular dependency with adaptive-routing.ts
 * (which imports ROLE_REQUIREMENTS and rankModelsForRole from this module).
 */
function selectModelForTaskFromCatalog(params: {
  task: string;
  role: AgentRole;
  catalog: ModelCatalogEntry[];
  allowedKeys?: Set<string>;
  cfg?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): { ref: ModelRef; complexity: string; downgraded: boolean } | null {
  const complexity = classifyComplexity(params.task);

  const COMPLEXITY_TO_ROLE: Record<string, AgentRole> = {
    trivial: "worker",
    moderate: "specialist",
    complex: "orchestrator",
  };

  // For complex tasks, prefer most capable model (highest cost tier + newest).
  if (complexity === "complex") {
    const ranked = rankModelsForRole(
      params.catalog,
      ROLE_REQUIREMENTS[params.role],
      params.allowedKeys,
      params.cfg,
      params.authStore,
    );
    if (ranked.length > 0) {
      const best = ranked[ranked.length - 1];
      return {
        ref: { provider: best.entry.provider, model: best.entry.id },
        complexity,
        downgraded: false,
      };
    }
    return null;
  }

  const cheaperRole = COMPLEXITY_TO_ROLE[complexity] ?? params.role;
  const cheaperReqs = ROLE_REQUIREMENTS[cheaperRole];
  const roleReqs = ROLE_REQUIREMENTS[params.role];
  const isDowngrade =
    COST_TIER_ORDER[cheaperReqs.maxCostTier] < COST_TIER_ORDER[roleReqs.maxCostTier];

  if (isDowngrade) {
    const merged: RoleRequirements = {
      minPerformanceTier: cheaperReqs.minPerformanceTier,
      requiredCapabilities: roleReqs.requiredCapabilities,
      maxCostTier: cheaperReqs.maxCostTier,
    };
    const cheapRanked = rankModelsForRole(
      params.catalog,
      merged,
      params.allowedKeys,
      params.cfg,
      params.authStore,
    );
    if (cheapRanked.length > 0) {
      const best = cheapRanked[0];
      return {
        ref: { provider: best.entry.provider, model: best.entry.id },
        complexity,
        downgraded: true,
      };
    }
  }

  // Fallback: use role's default requirements.
  const ranked = rankModelsForRole(
    params.catalog,
    roleReqs,
    params.allowedKeys,
    params.cfg,
    params.authStore,
  );
  if (ranked.length > 0) {
    const best = ranked[0];
    return {
      ref: { provider: best.entry.provider, model: best.entry.id },
      complexity,
      downgraded: false,
    };
  }

  // Relaxation: allow any cost tier if role's default also fails.
  if (roleReqs.maxCostTier !== "expensive") {
    const relaxed: RoleRequirements = { ...roleReqs, maxCostTier: "expensive" };
    const relaxedRanked = rankModelsForRole(
      params.catalog,
      relaxed,
      params.allowedKeys,
      params.cfg,
      params.authStore,
    );
    if (relaxedRanked.length > 0) {
      const best = relaxedRanked[0];
      return {
        ref: { provider: best.entry.provider, model: best.entry.id },
        complexity,
        downgraded: false,
      };
    }
  }

  // Final relaxation: drop all capability/performance requirements.
  const fullyRelaxed: RoleRequirements = {
    minPerformanceTier: "fast",
    requiredCapabilities: [],
    maxCostTier: "expensive",
  };
  const fullyRelaxedRanked = rankModelsForRole(
    params.catalog,
    fullyRelaxed,
    params.allowedKeys,
    params.cfg,
    params.authStore,
  );
  if (fullyRelaxedRanked.length > 0) {
    const best = fullyRelaxedRanked[0];
    return {
      ref: { provider: best.entry.provider, model: best.entry.id },
      complexity,
      downgraded: false,
    };
  }

  return null;
}

/** Get the cached model catalog. Exported for modules that need direct catalog access. */
export function getCachedModelCatalog(): ModelCatalogEntry[] {
  return cachedCatalog ?? [];
}

/** Reset auto-selection cache. Exported for test isolation. */
export function resetAutoModelSelection(): void {
  cachedSelections = null;
  cachedCatalog = null;
  cachedAllowedKeys = undefined;
  cachedCfg = undefined;
}
