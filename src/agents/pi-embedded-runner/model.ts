import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { discoverAuthStorage, discoverModels } from "@mariozechner/pi-coding-agent";

import type { MoltbotConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { resolveMoltbotAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { normalizeModelCompat } from "../model-compat.js";
import { normalizeProviderId } from "../model-selection.js";

type InlineModelEntry = ModelDefinitionConfig & { provider: string; baseUrl?: string };
export type InlineProviderConfig = {
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
  models?: ModelDefinitionConfig[];
};

/**
 * Read custom provider definitions from agentDir/models.json (synchronous).
 * Returns empty object on any error (file missing, parse error, etc.).
 * The returned type matches InlineProviderConfig for use with buildInlineProviderModels.
 */
function readModelsJsonProvidersSync(agentDir: string): Record<string, InlineProviderConfig> {
  try {
    const modelsJsonPath = path.join(agentDir, "models.json");
    const raw = fs.readFileSync(modelsJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
    // Cast to InlineProviderConfig - the buildInlineProviderModels function handles missing/invalid fields
    return (parsed.providers ?? {}) as Record<string, InlineProviderConfig>;
  } catch {
    return {};
  }
}

/**
 * Normalize a model ID to avoid double-prefixing.
 * If modelId starts with "provider/", strip it to get the raw model ID.
 */
export function normalizeModelId(provider: string, modelId: string): string {
  const prefix = `${provider}/`;
  if (modelId.startsWith(prefix)) {
    return modelId.slice(prefix.length);
  }
  return modelId;
}

/**
 * Build inline model entries from provider configurations.
 * Accepts both typed InlineProviderConfig and raw JSON objects from models.json.
 */
export function buildInlineProviderModels(
  providers: Record<string, InlineProviderConfig> | Record<string, unknown>,
): InlineModelEntry[] {
  return Object.entries(providers).flatMap(([providerId, entryRaw]) => {
    const trimmed = providerId.trim();
    if (!trimmed) return [];
    const entry = entryRaw as InlineProviderConfig | undefined;
    return (entry?.models ?? []).map((model) => ({
      ...model,
      provider: trimmed,
      baseUrl: entry?.baseUrl,
      api: model.api ?? entry?.api,
    }));
  });
}

export function buildModelAliasLines(cfg?: MoltbotConfig) {
  const models = cfg?.agents?.defaults?.models ?? {};
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) continue;
    const alias = String((entryRaw as { alias?: string } | undefined)?.alias ?? "").trim();
    if (!alias) continue;
    entries.push({ alias, model });
  }
  return entries
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}

/**
 * Resolve a model by provider and modelId.
 * Resolution order:
 *   1) pi-ai registry (discoverModels)
 *   2) agentDir/models.json custom providers (same source as `models list`)
 *   3) cfg.models?.providers (explicit config fallback)
 *   4) Create fallback model if provider config exists
 *   5) Return error with helpful context
 */
export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: MoltbotConfig,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: ReturnType<typeof discoverAuthStorage>;
  modelRegistry: ReturnType<typeof discoverModels>;
} {
  const resolvedAgentDir = agentDir ?? resolveMoltbotAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);

  // Normalize modelId to avoid double-prefixing (e.g., "ollama/llama3:chat" -> "llama3:chat")
  const rawModelId = normalizeModelId(provider, modelId);

  // 1) Try pi-ai registry first
  const model = modelRegistry.find(provider, rawModelId) as Model<Api> | null;
  if (model) {
    return { model: normalizeModelCompat(model), authStorage, modelRegistry };
  }

  // 2) Read custom providers from agentDir/models.json (same source as `models list`)
  const modelsJsonProviders = readModelsJsonProvidersSync(resolvedAgentDir);
  const modelsJsonEntries = buildInlineProviderModels(modelsJsonProviders)
    .filter((entry) => typeof entry.id === "string" && entry.id.length > 0)
    .map((entry) => ({
      ...entry,
      // Normalize model ID within models.json entries too
      id: normalizeModelId(entry.provider, entry.id),
    }));

  const normalizedProvider = normalizeProviderId(provider);
  const modelsJsonMatch = modelsJsonEntries.find(
    (entry) =>
      normalizeProviderId(entry.provider) === normalizedProvider && entry.id === rawModelId,
  );
  if (modelsJsonMatch) {
    const normalized = normalizeModelCompat({
      id: modelsJsonMatch.id,
      name: modelsJsonMatch.name || modelsJsonMatch.id,
      provider: modelsJsonMatch.provider,
      baseUrl: modelsJsonMatch.baseUrl ?? "",
      api: modelsJsonMatch.api ?? "openai-completions",
      input: modelsJsonMatch.input ?? ["text"],
      reasoning: modelsJsonMatch.reasoning ?? false,
      cost: modelsJsonMatch.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: modelsJsonMatch.contextWindow ?? 128000,
      maxTokens: modelsJsonMatch.maxTokens ?? 8192,
    } as Model<Api>);
    return { model: normalized, authStorage, modelRegistry };
  }

  // 3) Check cfg.models?.providers (existing fallback)
  const providers = cfg?.models?.providers ?? {};
  const inlineModels = buildInlineProviderModels(providers);
  const inlineMatch = inlineModels.find(
    (entry) =>
      normalizeProviderId(entry.provider) === normalizedProvider &&
      normalizeModelId(entry.provider, entry.id) === rawModelId,
  );
  if (inlineMatch) {
    const normalized = normalizeModelCompat(inlineMatch as Model<Api>);
    return { model: normalized, authStorage, modelRegistry };
  }

  // 4) Create fallback model if provider config exists (in cfg OR models.json)
  const providerCfg = providers[provider] ?? modelsJsonProviders[provider];
  if (providerCfg || rawModelId.startsWith("mock-")) {
    const fallbackModel: Model<Api> = normalizeModelCompat({
      id: rawModelId,
      name: rawModelId,
      api: providerCfg?.api ?? "openai-completions",
      provider,
      baseUrl: providerCfg?.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow:
        (providerCfg?.models?.[0] as { contextWindow?: number } | undefined)?.contextWindow ??
        DEFAULT_CONTEXT_TOKENS,
      maxTokens:
        (providerCfg?.models?.[0] as { maxTokens?: number } | undefined)?.maxTokens ??
        DEFAULT_CONTEXT_TOKENS,
    } as Model<Api>);
    return { model: fallbackModel, authStorage, modelRegistry };
  }

  // 5) Build helpful error with known models for this provider
  const knownModelsForProvider = modelsJsonEntries
    .filter((entry) => normalizeProviderId(entry.provider) === normalizedProvider)
    .map((entry) => entry.id)
    .slice(0, 5);
  const knownModelsHint =
    knownModelsForProvider.length > 0
      ? ` Known models for ${provider}: ${knownModelsForProvider.join(", ")}`
      : "";

  return {
    error: `Unknown model: ${provider}/${rawModelId} (agentDir: ${resolvedAgentDir}).${knownModelsHint}`,
    authStorage,
    modelRegistry,
  };
}
