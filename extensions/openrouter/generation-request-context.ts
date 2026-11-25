import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  resolveProviderApiKeyHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

type OpenRouterAuthStore = Parameters<typeof resolveApiKeyForProvider>[0]["store"];

export async function resolveOpenRouterGenerationRequestContext(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: OpenRouterAuthStore;
  capability: "audio" | "image" | "video";
  jsonContentType: boolean;
}) {
  return resolveProviderApiKeyHttpRequestConfig({
    req: params,
    missingApiKeyMessage: "OpenRouter API key missing",
    jsonContentType: params.jsonContentType,
    baseUrl: params.cfg.models?.providers?.openrouter?.baseUrl,
    defaultBaseUrl: OPENROUTER_BASE_URL,
    allowPrivateNetwork: false,
    request: sanitizeConfiguredModelProviderRequest(
      params.cfg.models?.providers?.openrouter?.request,
    ),
    provider: "openrouter",
    capability: params.capability,
  });
}
