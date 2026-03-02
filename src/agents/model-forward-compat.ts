import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { normalizeModelCompat } from "./model-compat.js";
import { normalizeProviderId } from "./model-selection.js";

const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;

const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;
const ANTHROPIC_OPUS_46_FAST_MODEL_ID = "claude-opus-4-6-fast";
const ANTHROPIC_OPUS_46_DOT_FAST_MODEL_ID = "claude-opus-4.6-fast";
const ANTHROPIC_SONNET_46_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = "claude-sonnet-4.6";
const ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS = ["claude-sonnet-4-5", "claude-sonnet-4.5"] as const;

const ZAI_GLM5_MODEL_ID = "glm-5";
const ZAI_GLM5_TEMPLATE_MODEL_IDS = ["glm-4.7"] as const;

// gemini-3.1-pro-preview / gemini-3.1-flash-preview are not yet in pi-ai's built-in
// google-gemini-cli catalog. Clone the gemini-3-pro/flash-preview template so users
// don't get "Unknown model" errors when Google releases a new minor version.
const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3-pro-preview"] as const;
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview"] as const;

const ANTIGRAVITY_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTIGRAVITY_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTIGRAVITY_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;
const ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID = "claude-opus-4-6-thinking";
const ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID = "claude-opus-4.6-thinking";
const ANTIGRAVITY_OPUS_THINKING_TEMPLATE_MODEL_IDS = [
  "claude-opus-4-5-thinking",
  "claude-opus-4.5-thinking",
] as const;

export const ANTIGRAVITY_OPUS_46_FORWARD_COMPAT_CANDIDATES = [
  {
    id: ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID,
    templatePrefixes: [
      "google-antigravity/claude-opus-4-5-thinking",
      "google-antigravity/claude-opus-4.5-thinking",
    ],
  },
  {
    id: ANTIGRAVITY_OPUS_46_MODEL_ID,
    templatePrefixes: ["google-antigravity/claude-opus-4-5", "google-antigravity/claude-opus-4.5"],
  },
] as const;

// Copilot "-1m" forward-compat candidates.
// The templatePrefixes point to the base model (without "-1m") so we can
// inherit auth status from it in the `models list` command.
export const COPILOT_1M_FORWARD_COMPAT_CANDIDATES = [
  {
    key: "github-copilot/claude-opus-4-6-1m",
    templatePrefixes: ["github-copilot/claude-opus-4-6", "github-copilot/claude-opus-4.6"],
  },
  {
    key: "github-copilot/claude-opus-4.6-1m",
    templatePrefixes: ["github-copilot/claude-opus-4.6", "github-copilot/claude-opus-4-6"],
  },
] as const;

// Copilot "-fast" forward-compat candidates.
// Clone from the base Opus model to inherit transport config.
export const COPILOT_FAST_FORWARD_COMPAT_CANDIDATES = [
  {
    key: "github-copilot/claude-opus-4-6-fast",
    templatePrefixes: ["github-copilot/claude-opus-4-6", "github-copilot/claude-opus-4.6"],
  },
  {
    key: "github-copilot/claude-opus-4.6-fast",
    templatePrefixes: ["github-copilot/claude-opus-4.6", "github-copilot/claude-opus-4-6"],
  },
] as const;

function cloneFirstTemplateModel(params: {
  normalizedProvider: string;
  trimmedModelId: string;
  templateIds: string[];
  modelRegistry: ModelRegistry;
  patch?: Partial<Model<Api>>;
}): Model<Api> | undefined {
  const { normalizedProvider, trimmedModelId, templateIds, modelRegistry } = params;
  for (const templateId of [...new Set(templateIds)].filter(Boolean)) {
    const template = modelRegistry.find(normalizedProvider, templateId) as Model<Api> | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
      ...params.patch,
    } as Model<Api>);
  }
  return undefined;
}

const CODEX_GPT53_ELIGIBLE_PROVIDERS = new Set(["openai-codex", "github-copilot"]);

function resolveOpenAICodexGpt53FallbackModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const trimmedModelId = modelId.trim();
  if (!CODEX_GPT53_ELIGIBLE_PROVIDERS.has(normalizedProvider)) {
    return undefined;
  }
  if (trimmedModelId.toLowerCase() !== OPENAI_CODEX_GPT_53_MODEL_ID) {
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

function resolveAnthropic46ForwardCompatModel(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  dashModelId: string;
  dotModelId: string;
  dashTemplateId: string;
  dotTemplateId: string;
  fallbackTemplateIds: readonly string[];
}): Model<Api> | undefined {
  const { provider, modelId, modelRegistry, dashModelId, dotModelId } = params;
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider !== "anthropic") {
    return undefined;
  }

  const trimmedModelId = modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  const is46Model =
    lower === dashModelId ||
    lower === dotModelId ||
    lower.startsWith(`${dashModelId}-`) ||
    lower.startsWith(`${dotModelId}-`);
  if (!is46Model) {
    return undefined;
  }

  const templateIds: string[] = [];
  if (lower.startsWith(dashModelId)) {
    templateIds.push(lower.replace(dashModelId, params.dashTemplateId));
  }
  if (lower.startsWith(dotModelId)) {
    templateIds.push(lower.replace(dotModelId, params.dotTemplateId));
  }
  templateIds.push(...params.fallbackTemplateIds);

  return cloneFirstTemplateModel({
    normalizedProvider,
    trimmedModelId,
    templateIds,
    modelRegistry,
  });
}

function resolveAnthropicOpus46ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  return resolveAnthropic46ForwardCompatModel({
    provider,
    modelId,
    modelRegistry,
    dashModelId: ANTHROPIC_OPUS_46_MODEL_ID,
    dotModelId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
    dashTemplateId: "claude-opus-4-5",
    dotTemplateId: "claude-opus-4.5",
    fallbackTemplateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS,
  });
}

function resolveAnthropicOpus46FastForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  return resolveAnthropic46ForwardCompatModel({
    provider,
    modelId,
    modelRegistry,
    dashModelId: ANTHROPIC_OPUS_46_FAST_MODEL_ID,
    dotModelId: ANTHROPIC_OPUS_46_DOT_FAST_MODEL_ID,
    dashTemplateId: "claude-opus-4-5",
    dotTemplateId: "claude-opus-4.5",
    fallbackTemplateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS,
  });
}

function resolveAnthropicSonnet46ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  return resolveAnthropic46ForwardCompatModel({
    provider,
    modelId,
    modelRegistry,
    dashModelId: ANTHROPIC_SONNET_46_MODEL_ID,
    dotModelId: ANTHROPIC_SONNET_46_DOT_MODEL_ID,
    dashTemplateId: "claude-sonnet-4-5",
    dotTemplateId: "claude-sonnet-4.5",
    fallbackTemplateIds: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS,
  });
}

// gemini-3.1-pro-preview / gemini-3.1-flash-preview are not present in pi-ai's built-in
// google-gemini-cli catalog yet. Clone the nearest gemini-3 template so users don't get
// "Unknown model" errors when Google Gemini CLI gains new minor-version models.
function resolveGoogleGeminiCli31ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  if (normalizeProviderId(provider) !== "google-gemini-cli") {
    return undefined;
  }
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();

  let templateIds: readonly string[];
  if (lower.startsWith(GEMINI_3_1_PRO_PREFIX)) {
    templateIds = GEMINI_3_1_PRO_TEMPLATE_IDS;
  } else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX)) {
    templateIds = GEMINI_3_1_FLASH_TEMPLATE_IDS;
  } else {
    return undefined;
  }

  return cloneFirstTemplateModel({
    normalizedProvider: "google-gemini-cli",
    trimmedModelId: trimmed,
    templateIds: [...templateIds],
    modelRegistry,
    patch: { reasoning: true },
  });
}

// Z.ai's GLM-5 may not be present in pi-ai's built-in model catalog yet.
// When a user configures zai/glm-5 without a models.json entry, clone glm-4.7 as a forward-compat fallback.
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

function resolveAntigravityOpus46ForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider !== "google-antigravity") {
    return undefined;
  }

  const trimmedModelId = modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  const isOpus46 =
    lower === ANTIGRAVITY_OPUS_46_MODEL_ID ||
    lower === ANTIGRAVITY_OPUS_46_DOT_MODEL_ID ||
    lower.startsWith(`${ANTIGRAVITY_OPUS_46_MODEL_ID}-`) ||
    lower.startsWith(`${ANTIGRAVITY_OPUS_46_DOT_MODEL_ID}-`);
  const isOpus46Thinking =
    lower === ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID ||
    lower === ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID ||
    lower.startsWith(`${ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID}-`) ||
    lower.startsWith(`${ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID}-`);
  if (!isOpus46 && !isOpus46Thinking) {
    return undefined;
  }

  const templateIds: string[] = [];
  if (lower.startsWith(ANTIGRAVITY_OPUS_46_MODEL_ID)) {
    templateIds.push(lower.replace(ANTIGRAVITY_OPUS_46_MODEL_ID, "claude-opus-4-5"));
  }
  if (lower.startsWith(ANTIGRAVITY_OPUS_46_DOT_MODEL_ID)) {
    templateIds.push(lower.replace(ANTIGRAVITY_OPUS_46_DOT_MODEL_ID, "claude-opus-4.5"));
  }
  if (lower.startsWith(ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID)) {
    templateIds.push(
      lower.replace(ANTIGRAVITY_OPUS_46_THINKING_MODEL_ID, "claude-opus-4-5-thinking"),
    );
  }
  if (lower.startsWith(ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID)) {
    templateIds.push(
      lower.replace(ANTIGRAVITY_OPUS_46_DOT_THINKING_MODEL_ID, "claude-opus-4.5-thinking"),
    );
  }
  templateIds.push(...ANTIGRAVITY_OPUS_TEMPLATE_MODEL_IDS);
  templateIds.push(...ANTIGRAVITY_OPUS_THINKING_TEMPLATE_MODEL_IDS);

  return cloneFirstTemplateModel({
    normalizedProvider,
    trimmedModelId,
    templateIds,
    modelRegistry,
  });
}

// GitHub Copilot proxies Claude models through its own backend and registers
// them in pi-ai's ModelRegistry with the correct api/baseUrl/headers.
// Standard models like "claude-opus-4.6" are already in the registry, but
// Copilot's "-1m" extended-context variants (e.g. "claude-opus-4.6-1m") are
// NOT registered.  We synthesize them by cloning the base model from the
// registry and overriding only id/name/contextWindow.  This preserves the
// real transport config (api: "anthropic-messages", Copilot baseUrl, auth
// headers) that buildCopilotModelDefinition() doesn't know about.
const COPILOT_CLAUDE_PREFIXES = ["claude-opus-", "claude-sonnet-", "claude-haiku-"];

// Context windows for Copilot's "-1m" variants.
// Only Opus 4.6 is verified; Copilot enforces ~936K empirically.
const COPILOT_1M_CONTEXT_WINDOW = 936_000;

// Strip the "-1m" suffix to find the base model id that's in the registry,
// trying both dot and dash notation.
function deriveCopilotBaseModelIds(modelId: string): string[] {
  const lower = modelId.toLowerCase();
  if (!lower.endsWith("-1m")) {
    return [];
  }
  const base = lower.slice(0, -3); // strip "-1m"
  const candidates = [base];
  // "claude-opus-4.6" ↔ "claude-opus-4-6"
  if (base.includes(".")) {
    candidates.push(base.replace(/\./g, "-"));
  } else {
    candidates.push(base.replace(/-(\d+)$/, ".$1"));
  }
  return candidates;
}

function resolveGitHubCopilotForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  if (normalizedProvider !== "github-copilot" && normalizedProvider !== "copilot-proxy") {
    return undefined;
  }

  const trimmedModelId = modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  const isClaude = COPILOT_CLAUDE_PREFIXES.some((prefix) => lower.startsWith(prefix));
  if (!isClaude) {
    return undefined;
  }

  // For "-1m" variants, clone from the base model in the registry so we
  // inherit api, baseUrl, headers, and auth — then override contextWindow.
  const baseCandidates = deriveCopilotBaseModelIds(trimmedModelId);
  if (baseCandidates.length > 0) {
    return cloneFirstTemplateModel({
      normalizedProvider,
      trimmedModelId,
      templateIds: baseCandidates,
      modelRegistry,
      patch: { contextWindow: COPILOT_1M_CONTEXT_WINDOW },
    });
  }

  // For non-"-1m" Claude models that aren't in the registry yet (e.g. a
  // future "claude-sonnet-4-7" on Copilot), try dot/dash variants.
  const templateIds: string[] = [];
  if (lower.includes(".")) {
    templateIds.push(lower.replace(/\./g, "-"));
  } else {
    templateIds.push(lower.replace(/-(\d+)$/, ".$1"));
  }

  return cloneFirstTemplateModel({
    normalizedProvider,
    trimmedModelId,
    templateIds,
    modelRegistry,
  });
}

export function resolveForwardCompatModel(
  provider: string,
  modelId: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  return (
    resolveOpenAICodexGpt53FallbackModel(provider, modelId, modelRegistry) ??
    resolveAnthropicOpus46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveAnthropicOpus46FastForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveAnthropicSonnet46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveZaiGlm5ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveGoogleGeminiCli31ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveAntigravityOpus46ForwardCompatModel(provider, modelId, modelRegistry) ??
    resolveGitHubCopilotForwardCompatModel(provider, modelId, modelRegistry)
  );
}
