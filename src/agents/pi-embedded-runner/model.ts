import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { normalizeModelCompat } from "../model-compat.js";
import { resolveForwardCompatModel } from "../model-forward-compat.js";
import { normalizeProviderId } from "../model-selection.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";

type InlineModelEntry = ModelDefinitionConfig & {
  provider: string;
  baseUrl?: string;
  headers?: Record<string, string>;
};
type InlineProviderConfig = {
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
  models?: ModelDefinitionConfig[];
  headers?: Record<string, string>;
};

export { buildModelAliasLines };

export function buildInlineProviderModels(
  providers: Record<string, InlineProviderConfig>,
): InlineModelEntry[] {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    const trimmed = providerId.trim();
    if (!trimmed) {
      return [];
    }
    return (entry?.models ?? []).map((model) => ({
      ...model,
      provider: trimmed,
      baseUrl: entry?.baseUrl,
      api: model.api ?? entry?.api,
      headers:
        entry?.headers || (model as InlineModelEntry).headers
          ? { ...entry?.headers, ...(model as InlineModelEntry).headers }
          : undefined,
    }));
  });
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;

  if (!model) {
    const providers = cfg?.models?.providers ?? {};
    const inlineModels = buildInlineProviderModels(providers);
    const normalizedProvider = normalizeProviderId(provider);
    const inlineMatch = inlineModels.find(
      (entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId,
    );
    if (inlineMatch) {
      const normalized = normalizeModelCompat(inlineMatch as Model<Api>);
      return {
        model: normalized,
        authStorage,
        modelRegistry,
      };
    }
    // Forward-compat fallbacks must be checked BEFORE the generic providerCfg fallback.
    // Otherwise, configured providers can default to a generic API and break specific transports.
    const forwardCompat = resolveForwardCompatModel(provider, modelId, modelRegistry);
    if (forwardCompat) {
      return { model: forwardCompat, authStorage, modelRegistry };
    }
    // OpenRouter is a pass-through proxy — any model ID available on OpenRouter
    // should work without being pre-registered in the local catalog.
    if (normalizedProvider === "openrouter") {
      const fallbackModel: Model<Api> = normalizeModelCompat({
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider,
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: DEFAULT_CONTEXT_TOKENS,
        // Align with OPENROUTER_DEFAULT_MAX_TOKENS in models-config.providers.ts
        maxTokens: 8192,
      } as Model<Api>);
      return { model: fallbackModel, authStorage, modelRegistry };
    }
    const providerCfg = providers[provider];
    if (providerCfg || modelId.startsWith("mock-")) {
      const configuredModel = providerCfg?.models?.find((candidate) => candidate.id === modelId);
      const fallbackModel: Model<Api> = normalizeModelCompat({
        id: modelId,
        name: modelId,
        api: providerCfg?.api ?? "openai-responses",
        provider,
        baseUrl: providerCfg?.baseUrl,
        reasoning: configuredModel?.reasoning ?? false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow:
          configuredModel?.contextWindow ??
          providerCfg?.models?.[0]?.contextWindow ??
          DEFAULT_CONTEXT_TOKENS,
        maxTokens:
          configuredModel?.maxTokens ??
          providerCfg?.models?.[0]?.maxTokens ??
          DEFAULT_CONTEXT_TOKENS,
        headers:
          providerCfg?.headers || configuredModel?.headers
            ? { ...providerCfg?.headers, ...configuredModel?.headers }
            : undefined,
      } as Model<Api>);
      return { model: fallbackModel, authStorage, modelRegistry };
    }
    return {
      error: buildUnknownModelError(provider, modelId, modelRegistry),
      authStorage,
      modelRegistry,
    };
  }
  const providerOverride = cfg?.models?.providers?.[provider] as InlineProviderConfig | undefined;
  if (providerOverride?.baseUrl || providerOverride?.headers) {
    const overridden: Model<Api> & { headers?: Record<string, string> } = { ...model };
    if (providerOverride.baseUrl) {
      overridden.baseUrl = providerOverride.baseUrl;
    }
    if (providerOverride.headers) {
      overridden.headers = {
        ...(model as Model<Api> & { headers?: Record<string, string> }).headers,
        ...providerOverride.headers,
      };
    }
    return { model: normalizeModelCompat(overridden), authStorage, modelRegistry };
  }
  return { model: normalizeModelCompat(model), authStorage, modelRegistry };
}

/**
 * Returns the normalized Levenshtein similarity between two strings (0–1).
 * A value of 1.0 means identical; 0.0 means completely different.
 */
function modelNameSimilarity(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  const maxLen = Math.max(aLower.length, bLower.length);
  if (maxLen === 0) {
    return 1;
  }
  const dist = levenshteinDistance(aLower, bLower);
  return 1 - dist / maxLen;
}

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] =
        b[i - 1] === a[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Scans the model registry for the closest matching model name within the
 * same provider.  Restricting the scan to same-provider entries ensures that
 * a high-scoring cross-provider coincidence can never shadow a lower-scoring
 * same-provider candidate and silently drop the suggestion.
 *
 * Returns a suggestion string (e.g. "anthropic/claude-sonnet-4-6") when
 * similarity exceeds the threshold, or null when nothing is close enough.
 */
function findSimilarModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
  threshold = 0.6,
): string | null {
  // Compare only the model-ID segments, not the full "provider/modelId"
  // strings.  Because we already filter to same-provider entries, both sides
  // always share the identical provider prefix; including it in the comparison
  // inflates max-length without adding information and causes short,
  // semantically unrelated model IDs (e.g. "abc" vs "xyz" under the same
  // provider) to cross the similarity threshold purely because the shared
  // prefix dominates the score.
  const providerLower = provider.toLowerCase();
  const allModels = modelRegistry.getAll();
  let bestModel: string | null = null;
  let bestScore = 0;
  for (const entry of allModels) {
    if (entry.provider.toLowerCase() !== providerLower) {
      continue;
    }
    const score = modelNameSimilarity(modelId, entry.id);
    if (score > bestScore && score >= threshold) {
      bestScore = score;
      bestModel = `${entry.provider}/${entry.id}`;
    }
  }
  return bestModel;
}

/**
 * Build a more helpful error when the model is not found.
 *
 * 1. Fuzzy suggestion — scans the registry for the closest model name and
 *    adds a "Did you mean?" hint when similarity is high enough (≥ 60%).
 * 2. Local provider hints — ollama/vllm require an API key to be registered;
 *    users often forget this, resulting in a confusing "Unknown model" error.
 *
 * See: https://github.com/openclaw/openclaw/issues/17328
 */
const LOCAL_PROVIDER_HINTS: Record<string, string> = {
  ollama:
    "Ollama requires authentication to be registered as a provider. " +
    'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
    "See: https://docs.openclaw.ai/providers/ollama",
  vllm:
    "vLLM requires authentication to be registered as a provider. " +
    'Set VLLM_API_KEY (any value works) or run "openclaw configure". ' +
    "See: https://docs.openclaw.ai/providers/vllm",
};

function buildUnknownModelError(
  provider: string,
  modelId: string,
  modelRegistry?: ModelRegistry,
): string {
  const base = `Unknown model: ${provider}/${modelId}.`;
  const parts: string[] = [base];

  // Resolve a same-provider fuzzy suggestion first so we can decide whether
  // the auth-configuration hint is appropriate.
  //
  // A same-provider match proves that the provider is already configured (its
  // models are visible in the registry), so showing the auth-setup hint
  // alongside it would be contradictory and confusing.
  //
  // Conversely, when no same-provider match exists the registry may be empty
  // for that provider because it is not configured at all — that is exactly
  // when the auth hint is actionable.
  // findSimilarModel already restricts its scan to same-provider entries, so
  // the returned value is guaranteed to be same-provider (or null).
  const sameproviderSuggestion: string | null =
    modelRegistry !== undefined ? findSimilarModel(provider, modelId, modelRegistry) : null;

  if (sameproviderSuggestion !== null) {
    parts.push(`Did you mean "${sameproviderSuggestion}"?`);
  } else {
    // No same-provider match: the provider may not be configured.
    // Surface the auth-configuration hint when one is available.
    const hint = LOCAL_PROVIDER_HINTS[provider.toLowerCase()];
    if (hint) {
      parts.push(hint);
    }
  }

  return parts.join(" ");
}
