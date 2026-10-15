import type { Model } from "../../llm/types.js";
import { applyLocalNoAuthHeaders, resolveExplicitProviderNoAuth } from "../model-auth-markers.js";
import type { AuthStorage } from "./auth-storage.js";
import type { ProviderRequestConfig, ResolvedRequestAuth } from "./model-registry-sources.js";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "./resolve-config-value.js";

/** Resolves registry request auth after the registry has scoped the provider to this route. */
export async function resolveModelRegistryRequestAuth(params: {
  model: Model;
  providerConfig: ProviderRequestConfig | undefined;
  modelHeaders: Record<string, string> | undefined;
  authStorage: AuthStorage;
}): Promise<ResolvedRequestAuth> {
  const { model, providerConfig, authStorage } = params;
  try {
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
