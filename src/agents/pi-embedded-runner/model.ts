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

const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT_53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";

const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;

// Well-known providers with sensible defaults for baseUrl and api type.
// Allows explicit model IDs like "openrouter/qwen/qwen3-14b" to resolve
// even without explicit models.providers.openrouter configuration.
const WELL_KNOWN_PROVIDER_DEFAULTS: Record<string, { baseUrl: string; api: string }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-responses" },
  opencode: { baseUrl: "https://opencode.dev/v1", api: "openai-responses" },
};

// pi-ai's built-in Anthropic catalog can lag behind OpenClaw's defaults/docs.
// Add forward-compat fallbacks for known-new IDs by cloning an older template model.
const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;

function resolveOpenAICodexGpt53FallbackModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const trimmedModelId = modelId.trim();
  if (normalizedProvider !== "openai-codex") {
    return undefined;
  }

  const lower = trimmedModelId.toLowerCase();
  const isGpt53 = lower === OPENAI_CODEX_GPT_53_MODEL_ID;
  const isSpark = lower === OPENAI_CODEX_GPT_53_SPARK_MODEL_ID;
  if (!isGpt53 && !isSpark) {
    return undefined;
  }

  for (const templateId of OPENAI_CODEX_TEMPLATE_MODEL_IDS) {
    const template = modelRegistry.find(normalizedProvider, templateId) as Model<Api> | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
      // Spark is a low-latency variant; keep api/baseUrl from template.
      ...(isSpark ? { reasoning: true } : {}),
    } as Model<Api>);
  }

  return normalizeModelCompat({
    id: trimmedModelId,
    name: trimmedModelId,
    api: "openai-codex-responses",
    provider: normalizedProvider,
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  } as Model<Api>);
}

function resolveAnthropicOpus46ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider !== "anthropic") {
    return undefined;
  }

  const trimmedModelId = modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  const isOpus46 =
    lower === ANTHROPIC_OPUS_46_MODEL_ID ||
    lower === ANTHROPIC_OPUS_46_DOT_MODEL_ID ||
    lower.startsWith(`${ANTHROPIC_OPUS_46_MODEL_ID}-`) ||
    lower.startsWith(`${ANTHROPIC_OPUS_46_DOT_MODEL_ID}-`);
  if (!isOpus46) {
    return undefined;
  }

  const templateIds: string[] = [];
  if (lower.startsWith(ANTHROPIC_OPUS_46_MODEL_ID)) {
    templateIds.push(lower.replace(ANTHROPIC_OPUS_46_MODEL_ID, "claude-opus-4-5"));
  }
  if (lower.startsWith(ANTHROPIC_OPUS_46_DOT_MODEL_ID)) {
    templateIds.push(lower.replace(ANTHROPIC_OPUS_46_DOT_MODEL_ID, "claude-opus-4.5"));
  }
  templateIds.push(...ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS);

  for (const templateId of [...new Set(templateIds)].filter(Boolean)) {
    const template = modelRegistry.find(normalizedProvider, templateId) as Model<Api> | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
    } as Model<Api>);
  }

  return undefined;
}

// Z.ai's GLM-5 may not be present in pi-ai's built-in model catalog yet.
// When a user configures zai/glm-5 without a models.json entry, clone glm-4.7 as a forward-compat fallback.
const ZAI_GLM5_MODEL_ID = "glm-5";
const ZAI_GLM5_TEMPLATE_MODEL_IDS = ["glm-4.7"] as const;

function resolveZaiGlm5ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  if (normalizeProviderId(provider) !== "zai") {
    return undefined;
  }
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  if (lower !== ZAI_GLM5_MODEL_ID && !lower.startsWith(`${ZAI_GLM5_MODEL_ID}-`)) {
    return undefined;
  }

  for (const templateId of ZAI_GLM5_TEMPLATE_MODEL_IDS) {
    const template = modelRegistry.find("zai", templateId) as Model<Api> | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmed,
      name: trimmed,
      reasoning: true,
    } as Model<Api>);
  }

  return normalizeModelCompat({
    id: trimmed,
    name: trimmed,
    api: "openai-completions",
    provider: "zai",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  } as Model<Api>);
}

// google-antigravity's model catalog in pi-ai can lag behind the actual platform.
// When a google-antigravity model ID contains "opus-4-6" (or "opus-4.6") but isn't
// in the registry yet, clone the opus-4-5 template so the correct api
// ("google-gemini-cli") and baseUrl are preserved.
const ANTIGRAVITY_OPUS_46_STEMS = ["claude-opus-4-6", "claude-opus-4.6"] as const;
const ANTIGRAVITY_OPUS_45_TEMPLATES = ["claude-opus-4-5-thinking", "claude-opus-4-5"] as const;

function resolveAntigravityOpus46ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  if (normalizeProviderId(provider) !== "google-antigravity") {
    return undefined;
  }
  const lower = modelId.trim().toLowerCase();
  const isOpus46 = ANTIGRAVITY_OPUS_46_STEMS.some(
    (stem) => lower === stem || lower.startsWith(`${stem}-`),
  );
  if (!isOpus46) {
    return undefined;
  }
  for (const templateId of ANTIGRAVITY_OPUS_45_TEMPLATES) {
    const template = modelRegistry.find("google-antigravity", templateId) as Model<Api> | null;
    if (template) {
      return normalizeModelCompat({
        ...template,
        id: modelId.trim(),
        name: modelId.trim(),
      } as Model<Api>);
    }
  }
  return undefined;
}

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
    const providerCfg = providers[provider];
    const wellKnownDefaults = WELL_KNOWN_PROVIDER_DEFAULTS[normalizedProvider];
    if (providerCfg || wellKnownDefaults || modelId.startsWith("mock-")) {
      const fallbackModel: Model<Api> = normalizeModelCompat({
        id: modelId,
        name: modelId,
        api: providerCfg?.api ?? wellKnownDefaults?.api ?? "openai-responses",
        provider,
        baseUrl: providerCfg?.baseUrl ?? wellKnownDefaults?.baseUrl,
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
