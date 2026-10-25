import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  markdownToText,
  resolvePositiveTimeoutSeconds,
} from "openclaw/plugin-sdk/provider-web-fetch";
import {
  postTrustedWebToolsJson,
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search";
import { isBlockedHostnameOrIp, SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const MAX_RESPONSE_BYTES = 10_000_000;

export async function executeDeepSeekFetch(
  ctx: { config?: OpenClawConfig; fetchConfig?: Record<string, unknown> },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const url = readStringParam(args, "url", { required: true });
  const parsed = url.length <= 8_192 ? URL.parse(url) : null;
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "DeepSeek Fetch needs an HTTP(S) URL of at most 8192 characters without credentials.",
    );
  }
  if (isBlockedHostnameOrIp(parsed.hostname)) {
    throw new SsrFBlockedError("DeepSeek Fetch cannot delegate a private or internal URL.");
  }
  const plugin = resolveProviderWebSearchPluginConfig(ctx.config, "deepseek");
  const apiKey =
    readConfiguredSecretString(
      plugin?.apiKey,
      "plugins.entries.deepseek.config.webSearch.apiKey",
    ) ??
    readProviderEnvValue(["DEEPSEEK_API_KEY"]) ??
    readConfiguredSecretString(
      ctx.config?.models?.providers?.deepseek?.apiKey,
      "models.providers.deepseek.apiKey",
    );
  if (!apiKey) {
    throw new Error(
      "web_fetch (deepseek) needs a DeepSeek API key. Set DEEPSEEK_API_KEY, configure plugins.entries.deepseek.config.webSearch.apiKey, or reuse models.providers.deepseek.apiKey.",
    );
  }
  const payload = await postTrustedWebToolsJson(
    {
      url: FETCH_URL,
      apiKey,
      body: { url },
      timeoutSeconds: resolvePositiveTimeoutSeconds(ctx.fetchConfig?.timeoutSeconds, 30),
      signal,
      errorLabel: "DeepSeek Fetch",
    },
    async (response) => {
      const data = await readProviderJsonObjectResponse(response, "DeepSeek Fetch API error", {
        maxBytes: MAX_RESPONSE_BYTES,
      });
      if (typeof data.content !== "string" || !data.content.trim()) {
        throw new Error("DeepSeek Fetch API error: missing or empty page content");
      }
      return {
        content: data.content,
        title: normalizeOptionalString(data.title),
      };
    },
  );
  signal?.throwIfAborted();
  const extractMode = args.extractMode === "text" ? "text" : "markdown";
  // Core owns output wrapping, maxChars, spill files, and the fetch cache.
  return {
    url,
    finalUrl: url,
    status: 200,
    contentType: extractMode === "text" ? "text/plain" : "text/markdown",
    extractMode,
    extractor: "deepseek",
    ...(payload.title ? { title: payload.title } : {}),
    text: extractMode === "text" ? markdownToText(payload.content) : payload.content,
  };
}
