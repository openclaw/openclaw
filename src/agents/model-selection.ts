/**
 * Model Selection & Routing
 *
 * PRECEDENCE ORDER (highest to lowest priority):
 *
 * 1. **Complexity Routing** (modelByComplexity.{trivial|moderate|complex})
 *    - Triggered when: modelByComplexity.enabled=true OR any complexity slot is configured
 *    - Applies to: ALL task types (coding, reasoning, tools, vision, conversation)
 *    - Configuration: agents.defaults.modelByComplexity.{trivial|moderate|complex}
 *    - Notes:
 *      - autoPickFromPool only affects UI behavior (whether user can pick from pool)
 *      - Complexity routing is explicit configuration and always applies when enabled
 *
 * 2. **Task-Type Specific Models**
 *    - codingModel: agents.defaults.codingModel (for coding tasks)
 *    - imageModel: agents.defaults.imageModel (for vision tasks, checked BEFORE complexity)
 *    - toolModel: agents.defaults.toolModel (for tool/system operation tasks)
 *    - reasoningModel: falls back to default (reasoning models are typically primary)
 *    - Vision tasks check imageModel first (before complexity) to avoid text-only models
 *
 * 3. **Default Model** (agents.defaults.model.primary)
 *    - Agent-specific override: agents.agents.<agentId>.model
 *    - Auto-selection by role: based on agent role (when enabled)
 *    - Global default: configured primary model
 *    - Fallback: hardcoded DEFAULT_MODEL
 *
 * BACKWARD COMPATIBILITY:
 * - Existing configs continue to work unchanged
 * - autoPickFromPool=false now only disables UI pool selection (not complexity routing)
 * - codingModel/imageModel/toolModel are honored AFTER complexity routing
 */

import type { OpenClawConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import type { TaskComplexity, TaskType } from "./task-classifier.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveAgentConfig, resolveAgentModelPrimary, resolveAgentRole } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { getAutoSelectedModel } from "./model-auto-select.js";
import { normalizeGoogleModelId } from "./models-config.providers.js";

export type ModelRef = {
  provider: string;
  model: string;
  accountTag?: string;
};

export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelAliasIndex = {
  byAlias: Map<string, { alias: string; ref: ModelRef }>;
  byKey: Map<string, string[]>;
};

function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase();
}

export function modelKey(provider: string, model: string) {
  return `${provider}/${model}`;
}

export function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "opencode-zen") {
    return "opencode";
  }
  if (normalized === "qwen") {
    return "qwen-portal";
  }
  if (normalized === "kimi-code") {
    return "kimi-coding";
  }
  return normalized;
}

export function isCliProvider(provider: string, cfg?: OpenClawConfig): boolean {
  const normalized = normalizeProviderId(provider);
  if (normalized === "claude-cli") {
    return true;
  }
  if (normalized === "codex-cli") {
    return true;
  }
  const backends = cfg?.agents?.defaults?.cliBackends ?? {};
  return Object.keys(backends).some((key) => normalizeProviderId(key) === normalized);
}

function normalizeAnthropicModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "opus-4.6") {
    return "claude-opus-4-6";
  }
  if (lower === "opus-4.5") {
    return "claude-opus-4-5";
  }
  if (lower === "sonnet-4.5") {
    return "claude-sonnet-4-5";
  }
  return trimmed;
}

function normalizeProviderModelId(provider: string, model: string): string {
  if (provider === "anthropic") {
    return normalizeAnthropicModelId(model);
  }
  if (provider === "google") {
    return normalizeGoogleModelId(model);
  }
  return model;
}

export function parseModelRef(raw: string, defaultProvider: string): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  // Extract accountTag if present (format: provider/model@tag)
  const atIndex = trimmed.indexOf("@");
  const accountTag = atIndex !== -1 ? trimmed.slice(atIndex + 1).trim() || undefined : undefined;
  const providerModelPart = atIndex !== -1 ? trimmed.slice(0, atIndex).trim() : trimmed;

  const slash = providerModelPart.indexOf("/");
  if (slash === -1) {
    const provider = normalizeProviderId(defaultProvider);
    const model = normalizeProviderModelId(provider, providerModelPart);
    return { provider, model, accountTag };
  }
  const providerRaw = providerModelPart.slice(0, slash).trim();
  const provider = normalizeProviderId(providerRaw);
  const model = providerModelPart.slice(slash + 1).trim();
  if (!provider || !model) {
    return null;
  }
  const normalizedModel = normalizeProviderModelId(provider, model);
  return { provider, model: normalizedModel, accountTag };
}

export function buildModelAliasIndex(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
}): ModelAliasIndex {
  const byAlias = new Map<string, { alias: string; ref: ModelRef }>();
  const byKey = new Map<string, string[]>();

  const rawModels = params.cfg.agents?.defaults?.models ?? {};
  for (const [keyRaw, entryRaw] of Object.entries(rawModels)) {
    const parsed = parseModelRef(String(keyRaw ?? ""), params.defaultProvider);
    if (!parsed) {
      continue;
    }
    const alias = String((entryRaw as { alias?: string } | undefined)?.alias ?? "").trim();
    if (!alias) {
      continue;
    }
    const aliasKey = normalizeAliasKey(alias);
    byAlias.set(aliasKey, { alias, ref: parsed });
    const key = modelKey(parsed.provider, parsed.model);
    const existing = byKey.get(key) ?? [];
    existing.push(alias);
    byKey.set(key, existing);
  }

  return { byAlias, byKey };
}

export function resolveModelRefFromString(params: {
  raw: string;
  defaultProvider: string;
  aliasIndex?: ModelAliasIndex;
}): { ref: ModelRef; alias?: string } | null {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.includes("/")) {
    const aliasKey = normalizeAliasKey(trimmed);
    const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
    if (aliasMatch) {
      return { ref: aliasMatch.ref, alias: aliasMatch.alias };
    }
  }
  const parsed = parseModelRef(trimmed, params.defaultProvider);
  if (!parsed) {
    return null;
  }
  return { ref: parsed };
}

export function resolveConfiguredModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
}): ModelRef {
  const rawModel = (() => {
    const raw = params.cfg.agents?.defaults?.model as { primary?: string } | string | undefined;
    if (typeof raw === "string") {
      return raw.trim();
    }
    return raw?.primary?.trim() ?? "";
  })();
  if (rawModel) {
    const trimmed = rawModel.trim();
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: params.defaultProvider,
    });
    if (!trimmed.includes("/")) {
      const aliasKey = normalizeAliasKey(trimmed);
      const aliasMatch = aliasIndex.byAlias.get(aliasKey);
      if (aliasMatch) {
        return aliasMatch.ref;
      }

      // Default to defaultProvider if no provider is specified.
      // Warn if it looks like an accidental omission, but honor the default.
      if (params.defaultProvider !== "anthropic") {
        // Silent fallback to configured default provider
        return { provider: params.defaultProvider, model: trimmed };
      }

      // Legacy behavior: warn if falling back to anthropic purely by accident
      console.warn(
        `[openclaw] Model "${trimmed}" specified without provider. Falling back to "${params.defaultProvider}/${trimmed}". Please use "${params.defaultProvider}/${trimmed}" in your config.`,
      );
      return { provider: params.defaultProvider, model: trimmed };
    }

    const resolved = resolveModelRefFromString({
      raw: trimmed,
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      return resolved.ref;
    }
  }
  return { provider: params.defaultProvider, model: params.defaultModel };
}

export function resolveDefaultModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): ModelRef {
  // 1. Check explicit per-agent model override
  const agentModelOverride = params.agentId
    ? resolveAgentModelPrimary(params.cfg, params.agentId)
    : undefined;

  if (agentModelOverride && agentModelOverride.length > 0) {
    const cfg = {
      ...params.cfg,
      agents: {
        ...params.cfg.agents,
        defaults: {
          ...params.cfg.agents?.defaults,
          model: {
            ...(typeof params.cfg.agents?.defaults?.model === "object"
              ? params.cfg.agents.defaults.model
              : undefined),
            primary: agentModelOverride,
          },
        },
      },
    };
    return resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
  }

  // 2. Auto-select based on agent role (if catalog has been initialized)
  const disableAutoSelect = isTruthyEnvValue(process.env.OPENCLAW_DISABLE_MODEL_AUTO_SELECT);
  if (!disableAutoSelect && params.agentId) {
    const role = resolveAgentRole(params.cfg, params.agentId);
    const autoSelected = getAutoSelectedModel(role);
    if (autoSelected) {
      return autoSelected;
    }
  }

  // 3. Fall back to global default
  return resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
}

export function buildAllowedModelSet(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
}): {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
} {
  const rawAllowlist = (() => {
    const modelMap = params.cfg.agents?.defaults?.models ?? {};
    return Object.keys(modelMap);
  })();
  const allowAny = rawAllowlist.length === 0;
  const defaultModel = params.defaultModel?.trim();
  const defaultKey =
    defaultModel && params.defaultProvider
      ? modelKey(params.defaultProvider, defaultModel)
      : undefined;
  const catalogKeys = new Set(params.catalog.map((entry) => modelKey(entry.provider, entry.id)));

  if (allowAny) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: params.catalog,
      allowedKeys: catalogKeys,
    };
  }

  const allowedKeys = new Set<string>();
  const configuredProviders = (params.cfg.models?.providers ?? {}) as Record<string, unknown>;
  for (const raw of rawAllowlist) {
    const parsed = parseModelRef(String(raw), params.defaultProvider);
    if (!parsed) {
      continue;
    }
    const key = modelKey(parsed.provider, parsed.model);
    const providerKey = normalizeProviderId(parsed.provider);
    if (isCliProvider(parsed.provider, params.cfg)) {
      allowedKeys.add(key);
    } else if (catalogKeys.has(key)) {
      allowedKeys.add(key);
    } else if (configuredProviders[providerKey] != null) {
      // Explicitly configured providers should be allowlist-able even when
      // they don't exist in the curated model catalog.
      allowedKeys.add(key);
    }
  }

  if (defaultKey) {
    allowedKeys.add(defaultKey);
  }

  const allowedCatalog = params.catalog.filter((entry) =>
    allowedKeys.has(modelKey(entry.provider, entry.id)),
  );

  if (allowedCatalog.length === 0 && allowedKeys.size === 0) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: params.catalog,
      allowedKeys: catalogKeys,
    };
  }

  return { allowAny: false, allowedCatalog, allowedKeys };
}

export type ModelRefStatus = {
  key: string;
  inCatalog: boolean;
  allowAny: boolean;
  allowed: boolean;
};

export function getModelRefStatus(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  ref: ModelRef;
  defaultProvider: string;
  defaultModel?: string;
}): ModelRefStatus {
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  const key = modelKey(params.ref.provider, params.ref.model);
  return {
    key,
    inCatalog: params.catalog.some((entry) => modelKey(entry.provider, entry.id) === key),
    allowAny: allowed.allowAny,
    allowed: allowed.allowAny || allowed.allowedKeys.has(key),
  };
}

export function resolveAllowedModelRef(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  raw: string;
  defaultProvider: string;
  defaultModel?: string;
}):
  | { ref: ModelRef; key: string }
  | {
      error: string;
    } {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return { error: "invalid model: empty" };
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const resolved = resolveModelRefFromString({
    raw: trimmed,
    defaultProvider: params.defaultProvider,
    aliasIndex,
  });
  if (!resolved) {
    return { error: `invalid model: ${trimmed}` };
  }

  const status = getModelRefStatus({
    cfg: params.cfg,
    catalog: params.catalog,
    ref: resolved.ref,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  if (!status.allowed) {
    return { error: `model not allowed: ${status.key}` };
  }

  return { ref: resolved.ref, key: status.key };
}

export function resolveThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
}): ThinkLevel {
  const configured = params.cfg.agents?.defaults?.thinkingDefault;
  if (configured) {
    return configured;
  }
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  if (candidate?.reasoning) {
    return "low";
  }
  return "off";
}

/**
 * Resolve the model configured for Gmail hook processing.
 * Returns null if hooks.gmail.model is not set.
 */
export function resolveHooksGmailModel(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
}): ModelRef | null {
  const hooksModel = params.cfg.hooks?.gmail?.model;
  if (!hooksModel?.trim()) {
    return null;
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });

  const resolved = resolveModelRefFromString({
    raw: hooksModel,
    defaultProvider: params.defaultProvider,
    aliasIndex,
  });

  return resolved?.ref ?? null;
}

/**
 * Resolve the coding-specialized model for an agent.
 * Falls back to the default model if no coding model is configured.
 */
export function resolveCodingModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): ModelRef {
  const codingModel = params.cfg.agents?.defaults?.codingModel as
    | { primary?: string }
    | string
    | undefined;

  const primary =
    typeof codingModel === "string" ? codingModel.trim() : codingModel?.primary?.trim();

  if (primary) {
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });

    const resolved = resolveModelRefFromString({
      raw: primary,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });

    if (resolved) {
      return resolved.ref;
    }
  }

  // Fallback to the default model
  return resolveDefaultModelForAgent(params);
}

/**
 * Resolve the tool-use/system-operations specialized model for an agent.
 * Falls back to the default model if no tool model is configured.
 */
export function resolveToolModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): ModelRef {
  const toolModel = params.cfg.agents?.defaults?.toolModel as
    | { primary?: string }
    | string
    | undefined;

  const primary = typeof toolModel === "string" ? toolModel.trim() : toolModel?.primary?.trim();

  if (primary) {
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });

    const resolved = resolveModelRefFromString({
      raw: primary,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });

    if (resolved) {
      return resolved.ref;
    }
  }

  return resolveDefaultModelForAgent(params);
}

/**
 * Resolve the reasoning-specialized model for an agent.
 * Uses the default model (reasoning models are typically set as primary).
 */
export function resolveReasoningModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): ModelRef {
  // For now, reasoning uses the default model since reasoning-capable
  // models are typically set as the primary model
  return resolveDefaultModelForAgent(params);
}

/**
 * Resolve the image-capable model for an agent.
 * Falls back to the default model if no image model is configured.
 */
export function resolveImageModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): ModelRef {
  const imageModel = params.cfg.agents?.defaults?.imageModel as
    | { primary?: string }
    | string
    | undefined;

  const primary = typeof imageModel === "string" ? imageModel.trim() : imageModel?.primary?.trim();

  if (primary) {
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });

    const resolved = resolveModelRefFromString({
      raw: primary,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });

    if (resolved) {
      return resolved.ref;
    }
  }

  // Fallback to the default model
  return resolveDefaultModelForAgent(params);
}

/**
 * Resolve the appropriate model based on the task type.
 * Uses specialized models when configured, falling back to defaults.
 */
export function resolveModelForTaskType(params: {
  cfg: OpenClawConfig;
  taskType: TaskType;
  agentId?: string;
}): ModelRef {
  const { cfg, taskType, agentId } = params;

  switch (taskType) {
    case "coding":
      return resolveCodingModelForAgent({ cfg, agentId });
    case "tools":
      return resolveToolModelForAgent({ cfg, agentId });
    case "vision":
      return resolveImageModelForAgent({ cfg, agentId });
    case "reasoning":
      return resolveReasoningModelForAgent({ cfg, agentId });
    default:
      return resolveDefaultModelForAgent({ cfg, agentId });
  }
}

export type ModelSelectionReason = "complexity" | "taskType" | "default";

export function resolveModelForTaskIntent(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  taskType: TaskType;
  complexity: TaskComplexity;
}): { ref: ModelRef; reason: ModelSelectionReason } {
  const { cfg, agentId, taskType, complexity } = params;

  // Special case: For vision tasks, check imageModel BEFORE complexity routing
  // to ensure we don't route to text-only models
  if (taskType === "vision") {
    const imageModelRaw = cfg.agents?.defaults?.imageModel as
      | { primary?: string }
      | string
      | undefined;
    const hasImageModel = Boolean(
      typeof imageModelRaw === "string" ? imageModelRaw.trim() : imageModelRaw?.primary?.trim(),
    );
    if (hasImageModel) {
      return { ref: resolveModelForTaskType({ cfg, taskType, agentId }), reason: "taskType" };
    }
    // Fall through to complexity routing if no imageModel configured
    // BUT validate the complexity-routed model supports vision
  }

  // PRIORITY 1: Check complexity routing (if enabled)
  // This applies to ALL task types when complexity mapping is configured
  const merged = (() => {
    const defaults = cfg.agents?.defaults?.modelByComplexity;
    const agentOverride = agentId ? resolveAgentConfig(cfg, agentId)?.modelByComplexity : undefined;
    if (!defaults && !agentOverride) {
      return null;
    }
    return { ...defaults, ...agentOverride };
  })();

  const enabled = (() => {
    if (!merged) {
      return false;
    }
    if (merged.enabled === true) {
      return true;
    }
    if (merged.enabled === false) {
      return false;
    }
    // Auto-enable if any complexity slot is configured
    return Boolean(merged.trivial?.trim() || merged.moderate?.trim() || merged.complex?.trim());
  })();

  if (enabled && merged) {
    const rawOverride =
      (complexity === "trivial"
        ? merged.trivial
        : complexity === "complex"
          ? merged.complex
          : merged.moderate) ?? "";

    const trimmed = rawOverride.trim();
    if (trimmed) {
      const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER });
      const resolved = resolveModelRefFromString({
        raw: trimmed,
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
      });
      if (resolved) {
        // Note: Vision validation for legacy complexity routing is basic (text-only provider check)
        // For full capability validation, use model pools system
        if (taskType === "vision") {
          const textOnlyProviders = new Set(["cerebras", "zai", "openrouter"]);
          if (textOnlyProviders.has(normalizeProviderId(resolved.ref.provider))) {
            // Known text-only provider - fall through to task-specific model
            const imageRef = resolveImageModelForAgent({ cfg, agentId });
            return { ref: imageRef, reason: "taskType" };
          }
        }
        return { ref: resolved.ref, reason: "complexity" };
      }
    }
  }

  // PRIORITY 2: Check task-type specific models (codingModel, toolModel, etc)
  const hasTaskSpecificModel = (() => {
    const hasPrimary = (raw: unknown): boolean => {
      if (typeof raw === "string") {
        return Boolean(raw.trim());
      }
      if (raw && typeof raw === "object" && "primary" in raw) {
        return Boolean((raw as { primary?: string }).primary?.trim());
      }
      return false;
    };
    switch (taskType) {
      case "coding":
        return hasPrimary(cfg.agents?.defaults?.codingModel);
      case "tools":
        return hasPrimary(cfg.agents?.defaults?.toolModel);
      case "vision":
        return hasPrimary(cfg.agents?.defaults?.imageModel);
      default:
        return false;
    }
  })();

  if (hasTaskSpecificModel) {
    return { ref: resolveModelForTaskType({ cfg, taskType, agentId }), reason: "taskType" };
  }

  // PRIORITY 3: Fall back to default model
  return { ref: resolveDefaultModelForAgent({ cfg, agentId }), reason: "default" };
}
