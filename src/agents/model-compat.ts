import type { Api, Model } from "@mariozechner/pi-ai";

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

/**
 * Resolve Anthropic base URL from environment variable.
 * Allows users to configure custom Anthropic API endpoints via ANTHROPIC_BASE_URL.
 */
function resolveAnthropicBaseUrl(): string {
  return process.env.ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_DEFAULT_BASE_URL;
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  let normalized = model;

  // Inject ANTHROPIC_BASE_URL for Anthropic provider when env var is set
  // Override default baseUrl when custom endpoint is configured via environment
  if (model.provider === "anthropic") {
    const anthropicBaseUrl = resolveAnthropicBaseUrl();
    if (anthropicBaseUrl !== ANTHROPIC_DEFAULT_BASE_URL) {
      // Only override if using default or no baseUrl (don't override explicit custom config)
      if (!model.baseUrl || model.baseUrl === ANTHROPIC_DEFAULT_BASE_URL) {
        normalized = { ...model, baseUrl: anthropicBaseUrl };
      }
    }
  }

  const baseUrl = normalized.baseUrl ?? "";
  const isZai = normalized.provider === "zai" || baseUrl.includes("api.z.ai");
  if (!isZai || !isOpenAiCompletionsModel(normalized)) {
    return normalized;
  }

  const openaiModel = normalized;
  const compat = openaiModel.compat ?? undefined;
  if (compat?.supportsDeveloperRole === false) {
    return normalized;
  }

  return {
    ...openaiModel,
    compat: compat ? { ...compat, supportsDeveloperRole: false } : { supportsDeveloperRole: false },
  };
}
