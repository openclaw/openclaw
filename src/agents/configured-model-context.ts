import type { OpenClawConfig } from "../config/config.js";
import { normalizeAnthropicModelId } from "./model-ref-shared.js";
import { normalizeProviderId } from "./provider-id.js";

type ConfiguredModelEntry = {
  id?: string;
  contextTokens?: number;
  contextWindow?: number;
};

type ConfiguredProviderEntry = {
  models?: ConfiguredModelEntry[];
};

type ModelsConfig = {
  providers?: Record<string, ConfiguredProviderEntry | undefined>;
};

function resolveConfiguredModelContextTokens(entry: ConfiguredModelEntry): number | undefined {
  return typeof entry.contextTokens === "number"
    ? entry.contextTokens
    : typeof entry.contextWindow === "number"
      ? entry.contextWindow
      : undefined;
}

function pushUnique(items: string[], value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || items.includes(trimmed)) {
    return;
  }
  items.push(trimmed);
}

function buildConfiguredProviderLookupIds(provider: string): string[] {
  const normalized = normalizeProviderId(provider);
  if (normalized === "claude-cli") {
    // Claude CLI runs Anthropic model families, so prefer Anthropic provider
    // metadata before any claude-cli-specific overrides.
    return ["anthropic", "claude-cli"];
  }

  const lookupIds: string[] = [];
  pushUnique(lookupIds, provider);
  pushUnique(lookupIds, normalized);
  return lookupIds;
}

function buildAnthropicModelLookupIds(model: string): string[] {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  const lookupIds: string[] = [];

  // Prefer family aliases when present so users can configure Anthropic limits
  // under stable ids like `sonnet` / `opus` even if the runtime model is a
  // versioned Claude id.
  if (
    lower === "sonnet" ||
    lower === "sonnet-4.6" ||
    lower === "claude-sonnet-4-6" ||
    lower === "claude-sonnet-4.6"
  ) {
    pushUnique(lookupIds, "sonnet");
    pushUnique(lookupIds, "claude-sonnet-4-6");
  } else if (
    lower === "opus" ||
    lower === "opus-4.6" ||
    lower === "claude-opus-4-6" ||
    lower === "claude-opus-4.6"
  ) {
    pushUnique(lookupIds, "opus");
    pushUnique(lookupIds, "claude-opus-4-6");
  }

  pushUnique(lookupIds, trimmed);
  pushUnique(lookupIds, normalizeAnthropicModelId(trimmed));
  return lookupIds;
}

function buildConfiguredModelLookupIds(provider: string, model: string): string[] {
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider === "anthropic" || normalizedProvider === "claude-cli") {
    return buildAnthropicModelLookupIds(model);
  }

  const lookupIds: string[] = [];
  pushUnique(lookupIds, model);
  return lookupIds;
}

function findContextTokensForProviderEntry(
  providerEntry: ConfiguredProviderEntry | undefined,
  modelLookupIds: string[],
): number | undefined {
  const models = providerEntry?.models;
  if (!Array.isArray(models)) {
    return undefined;
  }

  for (const modelId of modelLookupIds) {
    for (const entry of models) {
      const contextTokens = resolveConfiguredModelContextTokens(entry ?? {});
      if (
        typeof entry?.id === "string" &&
        entry.id === modelId &&
        typeof contextTokens === "number" &&
        contextTokens > 0
      ) {
        return contextTokens;
      }
    }
  }

  return undefined;
}

export function resolveConfiguredProviderContextTokens(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): number | undefined {
  const providers = (cfg?.models as ModelsConfig | undefined)?.providers;
  if (!providers) {
    return undefined;
  }

  const providerLookupIds = buildConfiguredProviderLookupIds(provider);
  const modelLookupIds = buildConfiguredModelLookupIds(provider, model);

  for (const providerLookupId of providerLookupIds) {
    const exactEntry = Object.entries(providers).find(
      ([id]) => id.trim().toLowerCase() === providerLookupId.toLowerCase(),
    )?.[1];
    const exactResult = findContextTokensForProviderEntry(exactEntry, modelLookupIds);
    if (exactResult !== undefined) {
      return exactResult;
    }

    const normalizedProvider = normalizeProviderId(providerLookupId);
    const normalizedEntry = Object.entries(providers).find(
      ([id]) => normalizeProviderId(id) === normalizedProvider,
    )?.[1];
    const normalizedResult = findContextTokensForProviderEntry(normalizedEntry, modelLookupIds);
    if (normalizedResult !== undefined) {
      return normalizedResult;
    }
  }

  return undefined;
}
