import type {
  ModelProviderConfig,
  ProviderModelRouteResolution,
  ProviderResolveModelRoutesContext,
} from "openclaw/plugin-sdk/provider-model-types";
import { normalizeGoogleProviderConfig } from "./provider-policy.js";
import { isOfficialGoogleAiStudioBaseUrl } from "./src/google-api-base-url.js";

export { resolveGoogleThinkingProfile as resolveThinkingProfile } from "./provider-policy.js";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return normalizeGoogleProviderConfig(params.provider, params.providerConfig);
}

export function resolveModelRoutes(
  context: ProviderResolveModelRoutesContext,
): ProviderModelRouteResolution | null {
  const api = context.configuredModel?.api ?? context.configuredProvider?.api;
  const baseUrl = context.configuredModel?.baseUrl ?? context.configuredProvider?.baseUrl;
  if (
    context.provider !== "google" ||
    (api !== "google-generative-ai" && api !== "google-interactions") ||
    typeof baseUrl !== "string" ||
    !isOfficialGoogleAiStudioBaseUrl(baseUrl)
  ) {
    return null;
  }
  // AI Studio supports an explicit choice of either native chat transport.
  return {
    kind: "routes",
    routes: [
      {
        api,
        baseUrl,
        authRequirement: "api-key",
        requestTransportOverrides: context.requestTransportOverrides ?? "none",
      },
    ],
  };
}
