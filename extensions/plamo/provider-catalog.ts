import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildPlamoCatalogModels, PLAMO_BASE_URL } from "./model-definitions.js";

const PROVIDER_ID = "plamo";
export const PLAMO_REQUEST_AUTH_MARKER = "plamo-request-auth";
const PLAMO_AUTH_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-proxy-token",
  "x-auth-token",
  "x-api-key",
  "api-key",
]);

export function buildPlamoProvider(): ModelProviderConfig {
  return {
    baseUrl: PLAMO_BASE_URL,
    api: "openai-completions",
    models: buildPlamoCatalogModels(),
  };
}

function resolveExplicitPlamoProviderConfig(ctx: ProviderCatalogContext) {
  const providers = ctx.config.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }
  return Object.entries(providers).find(
    ([configuredProviderId]) => configuredProviderId.trim().toLowerCase() === PROVIDER_ID,
  )?.[1];
}

export function hasConfiguredPlamoAuthHeaders(headers: unknown): boolean {
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (
        PLAMO_AUTH_HEADER_NAMES.has(headerName.trim().toLowerCase()) &&
        hasConfiguredSecretInput(headerValue)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function hasConfiguredPlamoRequestAuth(request: unknown): boolean {
  if (!request || typeof request !== "object") {
    return false;
  }
  const headers = (request as { headers?: unknown }).headers;
  if (hasConfiguredPlamoAuthHeaders(headers)) {
    return true;
  }
  const auth = (request as { auth?: unknown }).auth;
  if (!auth || typeof auth !== "object") {
    return false;
  }
  const mode = (auth as { mode?: unknown }).mode;
  if (mode === "authorization-bearer") {
    return hasConfiguredSecretInput((auth as { token?: unknown }).token);
  }
  if (mode === "header") {
    const headerName = (auth as { headerName?: unknown }).headerName;
    return (
      typeof headerName === "string" &&
      headerName.trim().length > 0 &&
      hasConfiguredSecretInput((auth as { value?: unknown }).value)
    );
  }
  return false;
}

export function hasConfiguredPlamoProviderAuth(providerConfig: unknown): boolean {
  if (!providerConfig || typeof providerConfig !== "object") {
    return false;
  }
  return (
    hasConfiguredPlamoAuthHeaders((providerConfig as { headers?: unknown }).headers) ||
    hasConfiguredPlamoRequestAuth((providerConfig as { request?: unknown }).request)
  );
}

export async function buildPlamoCatalog(ctx: ProviderCatalogContext) {
  const apiKey =
    ctx.resolveProviderAuth(PROVIDER_ID).apiKey ?? ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
  const explicitProvider = resolveExplicitPlamoProviderConfig(ctx);
  const explicitBaseUrl =
    typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : "";

  if (!apiKey && !hasConfiguredPlamoProviderAuth(explicitProvider)) {
    return null;
  }

  return {
    provider: {
      ...buildPlamoProvider(),
      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    },
  };
}
