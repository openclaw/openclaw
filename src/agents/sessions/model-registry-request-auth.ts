import type { Model } from "../../llm/types.js";
import { applyLocalNoAuthHeaders, resolveExplicitProviderNoAuth } from "../model-auth-markers.js";
import type { AuthStorage } from "./auth-storage.js";
import type { ProviderRequestConfig, ResolvedRequestAuth } from "./model-registry-sources.js";
import {
  resolveConfigValueOrThrow,
  resolveConfigValueUncached,
  resolveHeadersOrThrow,
} from "./resolve-config-value.js";

/** Resolves registry request auth after the registry has scoped the provider to this route. */
export async function resolveModelRegistryRequestAuth(params: {
  model: Model;
  providerConfig: ProviderRequestConfig | undefined;
  modelHeaders: Record<string, string> | undefined;
  authStorage: AuthStorage;
}): Promise<ResolvedRequestAuth> {
  const { model, providerConfig, authStorage } = params;
  try {
    if (providerConfig?.auth === "native-command") {
      return { ok: false, error: "Native command auth requires the Codex runtime." };
    }
    const noAuth = resolveExplicitProviderNoAuth({
      provider: model.provider,
      providerConfig: { auth: providerConfig?.auth },
      modelApi: model.api,
    });
    const usesAwsSdkAuth = providerConfig?.auth === "aws-sdk";
    const apiKeyFromAuthStorage = noAuth
      ? noAuth.apiKey
      : usesAwsSdkAuth
        ? undefined
        : await authStorage.getApiKey(model.provider, {
            includeFallback: false,
            baseUrl: model.baseUrl,
          });
    const apiKey =
      apiKeyFromAuthStorage ??
      (!usesAwsSdkAuth && providerConfig?.apiKey
        ? resolveConfigValueOrThrow(
            providerConfig.apiKey,
            `API key for provider "${model.provider}"`,
          )
        : undefined);

    // Unused Authorization values must not trigger environment or command credential resolution.
    const resolveHeaders = (headers: Record<string, string> | undefined, description: string) =>
      resolveHeadersOrThrow(
        noAuth && headers
          ? Object.fromEntries(
              Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"),
            )
          : headers,
        description,
      );
    const providerHeaders = resolveHeaders(providerConfig?.headers, `provider "${model.provider}"`);
    const modelHeaders = resolveHeaders(
      params.modelHeaders,
      `model "${model.provider}/${model.id}"`,
    );
    let headers =
      model.headers || providerHeaders || modelHeaders
        ? { ...model.headers, ...providerHeaders, ...modelHeaders }
        : undefined;

    if (noAuth) {
      headers = applyLocalNoAuthHeaders(model.api, noAuth.apiKey, headers);
    } else if (providerConfig?.authHeader) {
      if (!apiKey) {
        return { ok: false, error: `No API key found for "${model.provider}"` };
      }
      headers = { ...headers, Authorization: `Bearer ${apiKey}` };
    }

    return {
      ok: true,
      apiKey,
      headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Provider-only callers share the same native-only credential boundary as model requests. */
export async function resolveModelRegistryProviderApiKey(params: {
  provider: string;
  readProviderConfig: () => ProviderRequestConfig | undefined;
  authStorage: AuthStorage;
}): Promise<string | undefined> {
  if (params.readProviderConfig()?.auth === "native-command") {
    return undefined;
  }
  const apiKey = await params.authStorage.getApiKey(params.provider, { includeFallback: false });
  if (apiKey !== undefined) {
    return apiKey;
  }
  const providerApiKey = params.readProviderConfig()?.apiKey;
  return providerApiKey ? resolveConfigValueUncached(providerApiKey) : undefined;
}

/** Registry availability describes host credentials, never a native runtime's command. */
export function hasModelRegistryConfiguredAuth(params: {
  model: Model;
  providerConfig: ProviderRequestConfig | undefined;
  authStorage: AuthStorage;
}): boolean {
  const { model, providerConfig, authStorage } = params;
  if (providerConfig?.auth === "native-command") {
    return false;
  }
  if (providerConfig?.auth === "none") {
    return model.api === "openai-completions";
  }
  return (
    authStorage.hasAuth(model.provider) ||
    providerConfig?.auth === "aws-sdk" ||
    providerConfig?.apiKey !== undefined
  );
}
