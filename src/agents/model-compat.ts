import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

function isLoopbackHost(host: string): boolean {
  // "[::1]" is what URL.hostname returns for bracketed IPv6 literals (WHATWG URL spec).
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function isLmStudioEndpoint(provider: string, baseUrl: string): boolean {
  if (provider.trim().toLowerCase() === "lmstudio") {
    return true;
  }

  try {
    const url = new URL(baseUrl);
    return isLoopbackHost(url.hostname.toLowerCase()) && url.port === "1234";
  } catch {
    return /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):1234/i.test(baseUrl);
  }
}

function isQwen3FamilyModel(model: Model<Api>): boolean {
  const haystack = `${model.id} ${model.name}`.toLowerCase();
  return haystack.includes("qwen3");
}

/**
 * Returns true only for endpoints that are confirmed to be native OpenAI
 * infrastructure and therefore accept the `developer` message role.
 * Azure OpenAI uses the Chat Completions API and does NOT accept `developer`.
 * All other openai-completions backends (proxies, Qwen, GLM, DeepSeek, etc.)
 * only support the standard `system` role.
 */
function isOpenAINativeEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com";
  } catch {
    return false;
  }
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

  const compat = model.compat ?? undefined;
  const compatPatch: NonNullable<typeof compat> = {};

  if (isLmStudioEndpoint(model.provider, baseUrl) && isQwen3FamilyModel(model)) {
    // LM Studio's OpenAI-compatible chat-completions path expects Qwen-family
    // models to use `max_tokens` and Qwen's enable_thinking flag shape.
    if (compat?.maxTokensField === undefined) {
      compatPatch.maxTokensField = "max_tokens";
    }
    if (compat?.thinkingFormat === undefined) {
      compatPatch.thinkingFormat = "qwen";
    }
  }

  // The `developer` role and stream usage chunks are OpenAI-native behaviors.
  // Many OpenAI-compatible backends reject `developer` and/or emit usage-only
  // chunks that break strict parsers expecting choices[0]. For non-native
  // openai-completions endpoints, force both compat flags off.
  // When baseUrl is empty the pi-ai library defaults to api.openai.com, so
  // leave compat unchanged and let default native behavior apply.
  // Note: explicit true values are intentionally overridden for non-native
  // endpoints for safety.
  const needsForce = baseUrl ? !isOpenAINativeEndpoint(baseUrl) : false;
  if (needsForce) {
    if (compat?.supportsDeveloperRole !== false) {
      compatPatch.supportsDeveloperRole = false;
    }
    if (compat?.supportsUsageInStreaming !== false) {
      compatPatch.supportsUsageInStreaming = false;
    }
  }

  if (Object.keys(compatPatch).length === 0) {
    return model;
  }

  // Return a new object — do not mutate the caller's model reference.
  return { ...model, compat: compat ? { ...compat, ...compatPatch } : compatPatch } as typeof model;
}
