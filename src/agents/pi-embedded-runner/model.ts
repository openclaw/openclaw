import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { normalizeModelCompat } from "../model-compat.js";
import { resolveForwardCompatModel } from "../model-forward-compat.js";
import { normalizeProviderId } from "../model-selection.js";
import {
  discoverAuthStorage,
  discoverModels,
  type AuthStorage,
  type ModelRegistry,
} from "../pi-model-discovery.js";

type InlineModelEntry = ModelDefinitionConfig & { provider: string; baseUrl?: string };
type InlineProviderConfig = {
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
  models?: ModelDefinitionConfig[];
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
  const providers = cfg?.models?.providers ?? {};
  const inlineModels = buildInlineProviderModels(providers);
  const normalizedProvider = normalizeProviderId(provider);
  // When catalog/auth-choice maps codex-cli -> openai-codex, the run may pass provider "openai-codex".
  // Prefer config-defined codex-cli (8317 + openai-completions) over registry's openai-codex-responses,
  // so we do not send thread and hit Codex "state db missing rollout path". Same idea as antigravity-cli (no mapping).
  const codexCliConfigKey = Object.keys(providers).find(
    (k) => normalizeProviderId(k) === "codex-cli",
  );
  const claudeCliConfigKey = Object.keys(providers).find(
    (k) => normalizeProviderId(k) === "claude-cli",
  );
  if (normalizedProvider === "openai-codex" && codexCliConfigKey !== undefined) {
    const codexCliMatch = inlineModels.find(
      (entry) => normalizeProviderId(entry.provider) === "codex-cli" && entry.id === modelId,
    );
    if (codexCliMatch) {
      const normalized = normalizeModelCompat(codexCliMatch as Model<Api>);
      return { model: normalized, authStorage, modelRegistry };
    }
  }
  // When catalog/auth maps claude-cli -> anthropic, prefer config-defined claude-cli (8317 + openai-completions).
  if (normalizedProvider === "anthropic" && claudeCliConfigKey !== undefined) {
    const claudeCliMatch = inlineModels.find(
      (entry) => normalizeProviderId(entry.provider) === "claude-cli" && entry.id === modelId,
    );
    if (claudeCliMatch) {
      const normalized = normalizeModelCompat(claudeCliMatch as Model<Api>);
      return { model: normalized, authStorage, modelRegistry };
    }
  }
  // Prefer config-defined provider (e.g. codex-cli -> 8317 + openai-completions) over registry.
  // Use normalized lookup so provider key casing/spacing in config still matches.
  const configProviderKey = Object.keys(providers).find(
    (k) => normalizeProviderId(k) === normalizedProvider,
  );
  if (configProviderKey !== undefined && inlineModels.length > 0) {
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
  }
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
  // If registry returned openai-codex-responses (e.g. built-in) but config defines codex-cli
  // with this model, use config so we do not send thread and hit Codex rollout error (same as antigravity-cli path).
  if (model?.api === "openai-codex-responses" && codexCliConfigKey !== undefined) {
    const overrideMatch = inlineModels.find(
      (entry) => normalizeProviderId(entry.provider) === "codex-cli" && entry.id === modelId,
    );
    if (overrideMatch) {
      const normalized = normalizeModelCompat(overrideMatch as Model<Api>);
      return { model: normalized, authStorage, modelRegistry };
    }
  }
  // If registry returned anthropic API but config defines claude-cli with this model, use config (8317).
  if (
    (model?.api === "anthropic" || model?.api === "anthropic-messages") &&
    claudeCliConfigKey !== undefined
  ) {
    const overrideMatch = inlineModels.find(
      (entry) => normalizeProviderId(entry.provider) === "claude-cli" && entry.id === modelId,
    );
    if (overrideMatch) {
      const normalized = normalizeModelCompat(overrideMatch as Model<Api>);
      return { model: normalized, authStorage, modelRegistry };
    }
  }
  if (model?.api === "openai-codex-responses" && configProviderKey !== undefined) {
    const overrideMatch = inlineModels.find(
      (entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId,
    );
    if (overrideMatch) {
      const normalized = normalizeModelCompat(overrideMatch as Model<Api>);
      return { model: normalized, authStorage, modelRegistry };
    }
  }
  if (!model) {
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
    const providerCfg = providers[provider];
    if (providerCfg || modelId.startsWith("mock-")) {
      // When modelId equals provider name, upstream APIs (e.g. CLIProxyAPI) expect a real model id.
      const normalizedProv = normalizeProviderId(provider);
      const effectiveModelId =
        providerCfg?.models?.length &&
        (modelId === provider || normalizeProviderId(modelId) === normalizedProv)
          ? providerCfg.models[0].id
          : modelId;
      const fallbackModel: Model<Api> = normalizeModelCompat({
        id: effectiveModelId,
        name: effectiveModelId,
        api: providerCfg?.api ?? "openai-responses",
        provider,
        baseUrl: providerCfg?.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: providerCfg?.models?.[0]?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: providerCfg?.models?.[0]?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      } as Model<Api>);
      return { model: fallbackModel, authStorage, modelRegistry };
    }
    return {
      error: buildUnknownModelError(provider, modelId),
      authStorage,
      modelRegistry,
    };
  }
  return { model: normalizeModelCompat(model), authStorage, modelRegistry };
}

/**
 * Build a more helpful error when the model is not found.
 *
 * Local providers (ollama, vllm) need a dummy API key to be registered.
 * Users often configure `agents.defaults.model.primary: "ollama/…"` but
 * forget to set `OLLAMA_API_KEY`, resulting in a confusing "Unknown model"
 * error.  This detects known providers that require opt-in auth and adds
 * a hint.
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

function buildUnknownModelError(provider: string, modelId: string): string {
  const base = `Unknown model: ${provider}/${modelId}`;
  const hint = LOCAL_PROVIDER_HINTS[provider.toLowerCase()];
  return hint ? `${base}. ${hint}` : base;
}
