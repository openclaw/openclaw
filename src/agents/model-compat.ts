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
 * Returns true for OpenAI-compatible local inference servers that are known to
 * support `stream_options: { include_usage: true }` and return a valid usage
 * chunk at the end of the stream (llama.cpp, Ollama, vLLM, LMStudio, llamafile).
 *
 * Detection is based on the endpoint's IP address or hostname falling within
 * a private / loopback / link-local range:
 *
 *   - 127.0.0.0/8  — full loopback range (not only 127.0.0.1)
 *   - 10.0.0.0/8   — RFC-1918 class A
 *   - 172.16.0.0/12 — RFC-1918 class B
 *   - 192.168.0.0/16 — RFC-1918 class C
 *   - 169.254.0.0/16 — link-local
 *   - ::1           — IPv6 loopback
 *   - *.local       — mDNS (e.g. spark-38f8.local, raspberrypi.local)
 *
 * False positives (a cloud proxy that happens to be on a private subnet) are
 * acceptable: those endpoints either support include_usage or will silently
 * ignore the flag.
 */
export function isLocalInferenceEndpoint(baseUrl: string): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const { hostname } = new URL(baseUrl);
    const h = hostname.toLowerCase();

    // IPv6 loopback
    if (h === "::1" || h === "[::1]") {
      return true;
    }

    // hostname-based loopback
    if (h === "localhost") {
      return true;
    }

    // mDNS (.local) — covers raspberrypi.local, spark-38f8.local, etc.
    if (h.endsWith(".local")) {
      return true;
    }

    // Numeric IPv4: parse octets and check ranges
    const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [, a, b] = ipv4.map(Number);
      // 127.0.0.0/8 — full loopback range
      if (a === 127) {
        return true;
      }
      // 10.0.0.0/8
      if (a === 10) {
        return true;
      }
      // 172.16.0.0/12 (172.16–172.31)
      if (a === 172 && b >= 16 && b <= 31) {
        return true;
      }
      // 192.168.0.0/16
      if (a === 192 && b === 168) {
        return true;
      }
      // 169.254.0.0/16 — link-local
      if (a === 169 && b === 254) {
        return true;
      }
    }

    return false;
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
  // openai-completions endpoints, force both compat flags off.
  //
  // Exception: local inference servers (llama.cpp, Ollama, vLLM, LMStudio, etc.)
  // running on private/loopback addresses DO support stream_options.include_usage
  // and return valid usage chunks.  For those we only disable supportsDeveloperRole
  // (they do not accept the OpenAI `developer` system-message role) but leave
  // supportsUsageInStreaming at its configured value (default: true).
  const compat = model.compat ?? undefined;
  // When baseUrl is empty the pi-ai library defaults to api.openai.com, so
  // leave compat unchanged and let default native behavior apply.
  const needsForce = baseUrl ? !isOpenAINativeEndpoint(baseUrl) : false;
  if (!needsForce) {
    return model;
  }

  if (isLocalInferenceEndpoint(baseUrl)) {
    // Local server: disable developer role but keep streaming usage.
    if (compat?.supportsDeveloperRole === false) {
      return model;
    }
    return {
      ...model,
      compat: compat
        ? { ...compat, supportsDeveloperRole: false }
        : { supportsDeveloperRole: false },
    } as typeof model;
  }

  // Remote non-native endpoint: disable both flags (existing behavior).
  if (compat?.supportsDeveloperRole === false && compat?.supportsUsageInStreaming === false) {
    return model;
  }
  return {
    ...model,
    compat: compat
      ? { ...compat, supportsDeveloperRole: false, supportsUsageInStreaming: false }
      : { supportsDeveloperRole: false, supportsUsageInStreaming: false },
  } as typeof model;
}
