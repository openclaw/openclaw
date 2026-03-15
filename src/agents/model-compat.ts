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
function isOpenAINativeEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Local LLM servers (llama.cpp, LM Studio, Ollama, etc.) expose an
 * OpenAI-compatible API and typically support `stream_options.include_usage`.
 * Detect these by checking for localhost/loopback hostnames.
 */
function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host === "0.0.0.0"
    );
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

  // The `developer` role and stream usage chunks are OpenAI-native behaviors.
  // Many OpenAI-compatible backends reject `developer` and/or emit usage-only
  // chunks that break strict parsers expecting choices[0]. For non-native
  // openai-completions endpoints, force both compat flags off — unless the
  // user has explicitly opted in via their model config.
  const compat = model.compat ?? undefined;
  // When baseUrl is empty the pi-ai library defaults to api.openai.com, so
  // leave compat unchanged and let default native behavior apply.
  const needsForce = baseUrl ? !isOpenAINativeEndpoint(baseUrl) : false;
  if (!needsForce) {
    return model;
  }

  // Respect explicit user overrides: if the user has set a compat flag to
  // true in their model definition, they know their endpoint supports it.
  const forcedDeveloperRole = compat?.supportsDeveloperRole === true;
  const forcedUsageStreaming = compat?.supportsUsageInStreaming === true;
  // Local LLM servers (llama.cpp, LM Studio, Ollama) support usage in
  // streaming; default to true for local endpoints so token tracking works
  // out of the box without requiring explicit compat config.
  // Only apply as a default — respect explicit user opt-out.
  const explicitUsageOpt = typeof compat?.supportsUsageInStreaming === "boolean";
  const localUsageDefault = !explicitUsageOpt && isLocalEndpoint(baseUrl);

  if (forcedDeveloperRole && (forcedUsageStreaming || localUsageDefault)) {
    return model;
  }

  // Return a new object — do not mutate the caller's model reference.
  return {
    ...model,
    compat: compat
      ? {
          ...compat,
          supportsDeveloperRole: forcedDeveloperRole || false,
          supportsUsageInStreaming: forcedUsageStreaming || localUsageDefault,
        }
      : { supportsDeveloperRole: false, supportsUsageInStreaming: localUsageDefault },
  } as typeof model;
}
