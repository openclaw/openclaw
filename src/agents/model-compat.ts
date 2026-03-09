import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

/**
 * Returns true only for endpoints that are confirmed to be native OpenAI
 * infrastructure and therefore accept the `developer` message role.
 * Azure OpenAI uses the Chat Completions API and does NOT accept `developer`.
 * All other openai-completions backends (proxies, Qwen, GLM, DeepSeek, etc.)
 * only support the standard `system` role.
 */
function getHostname(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isOpenAINativeEndpoint(baseUrl: string): boolean {
  return getHostname(baseUrl) === "api.openai.com";
}

function isMistralEndpoint(model: Model<Api>): boolean {
  return model.provider === "mistral" || getHostname(model.baseUrl ?? "") === "api.mistral.ai";
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

/**
 * pi-ai constructs the Anthropic API endpoint as `${baseUrl}/v1/messages`.
 * If a user configures `baseUrl` with a trailing `/v1` (e.g. the previously
 * recommended format "https://api.anthropic.com/v1"), the resulting URL
 * becomes "…/v1/v1/messages" which the Anthropic API rejects with a 404.
 *
 * Strip a single trailing `/v1` (with optional trailing slash) from the
 * baseUrl for anthropic-messages models so users with either format work.
 */
function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}
export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";

  // Normalise anthropic-messages baseUrl: strip trailing /v1 that users may
  // have included in their config. pi-ai appends /v1/messages itself.
  if (isAnthropicMessagesModel(model) && baseUrl) {
    const normalised = normalizeAnthropicBaseUrl(baseUrl);
    if (normalised !== baseUrl) {
      return { ...model, baseUrl: normalised } as Model<"anthropic-messages">;
    }
  }

  if (!isOpenAiCompletionsModel(model)) {
    return model;
  }

  // The `developer` role and stream usage chunks are OpenAI-native behaviors.
  // Many OpenAI-compatible backends reject `developer` and/or emit usage-only
  // chunks that break strict parsers expecting choices[0]. For non-native
  // openai-completions endpoints, force both compat flags off.
  const compat = model.compat ?? undefined;
  // When baseUrl is empty the pi-ai library defaults to api.openai.com, so
  // leave compat unchanged and let default native behavior apply.
  // Note: explicit true values are intentionally overridden for non-native
  // endpoints for safety.
  const needsForce = baseUrl ? !isOpenAINativeEndpoint(baseUrl) : false;
  if (!needsForce) {
    return model;
  }
  if (compat?.supportsDeveloperRole === false && compat?.supportsUsageInStreaming === false) {
    return model;
  }

  const normalizedCompat = compat
    ? { ...compat, supportsDeveloperRole: false, supportsUsageInStreaming: false }
    : { supportsDeveloperRole: false, supportsUsageInStreaming: false };

  // Mistral's OpenAI-compatible /chat/completions endpoint is stricter than
  // OpenAI-native backends: it rejects `store`, uses `max_tokens` instead of
  // `max_completion_tokens`, and does not support OpenAI-style
  // `reasoning_effort`.
  if (isMistralEndpoint(model)) {
    normalizedCompat.supportsStore = false;
    normalizedCompat.supportsReasoningEffort = false;
    normalizedCompat.maxTokensField = "max_tokens";
  }

  // Return a new object — do not mutate the caller's model reference.
  return {
    ...model,
    compat: normalizedCompat,
  } as typeof model;
}
