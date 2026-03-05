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
 * Returns true for endpoints known to accept the `reasoning_effort` parameter.
 * Only native OpenAI endpoints are confirmed to support it. OpenRouter handles
 * reasoning via its own nested `reasoning.effort` format (injected separately).
 * All other openai-completions backends (Ollama, vLLM, custom proxies, etc.)
 * may reject or misinterpret the parameter, causing 400 errors or broken tool
 * calling. See: openclaw/openclaw#33272
 */
function isReasoningEffortEndpoint(baseUrl: string): boolean {
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

  // The `developer` message role is an OpenAI-native convention. All other
  // openai-completions backends (proxies, Qwen, GLM, DeepSeek, Kimi, etc.)
  // only recognise `system`. Force supportsDeveloperRole=false for any model
  // whose baseUrl is not a known native OpenAI endpoint, unless the caller
  // has already pinned the value explicitly.
  const compat = model.compat ?? undefined;
  // Only skip when both compat properties are already handled — otherwise
  // the reasoning guard below would be bypassed (#33272 regression).
  if (compat?.supportsDeveloperRole === false && compat?.supportsReasoningEffort !== undefined) {
    return model;
  }
  // When baseUrl is empty the pi-ai library defaults to api.openai.com, so
  // leave compat unchanged and let the existing default behaviour apply.
  // Note: an explicit supportsDeveloperRole: true is intentionally overridden
  // here for non-native endpoints — those backends would return a 400 if we
  // sent `developer`, so safety takes precedence over the caller's hint.
  const needsForce = baseUrl ? !isOpenAINativeEndpoint(baseUrl) : false;

  // Default supportsReasoningEffort to false for non-OpenAI endpoints.
  // pi-ai defaults supportsReasoningEffort to true for all unknown providers,
  // which causes reasoning_effort to be injected into requests to backends
  // that don't support it (Ollama, vLLM proxies, Kimi, etc.), breaking tool
  // calling or causing 400 errors. Only override when the user has not
  // explicitly set supportsReasoningEffort in their config.
  // See: openclaw/openclaw#33272
  const needsReasoningGuard =
    baseUrl && !isReasoningEffortEndpoint(baseUrl) && compat?.supportsReasoningEffort === undefined;

  if (!needsForce && !needsReasoningGuard) {
    return model;
  }

  // Return a new object — do not mutate the caller's model reference.
  const compatPatch: Record<string, unknown> = {};
  if (needsForce) {
    compatPatch.supportsDeveloperRole = false;
  }
  if (needsReasoningGuard) {
    compatPatch.supportsReasoningEffort = false;
  }
  return {
    ...model,
    compat: compat ? { ...compat, ...compatPatch } : compatPatch,
  } as typeof model;
}
