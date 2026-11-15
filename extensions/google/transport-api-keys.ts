import type { Model, ModelRequestHeaders, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import { collectProviderApiKeysForExecution } from "openclaw/plugin-sdk/provider-auth-runtime";
import { parseGeminiAuth } from "./gemini-auth.js";
import { isOfficialGoogleAiStudioBaseUrl } from "./provider-policy.js";

function hasGoogleAuthHeader(headers: ModelRequestHeaders | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => {
    const normalized = name.trim().toLowerCase();
    return normalized === "authorization" || normalized === "x-goog-api-key";
  });
}

export function collectGoogleTransportApiKeys(
  model: Pick<Model, "provider" | "baseUrl" | "headers">,
  options: Pick<SimpleStreamOptions, "headers"> | undefined,
  apiKey: string | undefined,
): string[] {
  return isOfficialGoogleAiStudioBaseUrl(model.baseUrl) &&
    !(apiKey?.trimStart().startsWith("{") && parseGeminiAuth(apiKey).headers.Authorization) &&
    !hasGoogleAuthHeader(model.headers) &&
    !hasGoogleAuthHeader(options?.headers)
    ? collectProviderApiKeysForExecution({ provider: model.provider, primaryApiKey: apiKey })
    : [];
}
