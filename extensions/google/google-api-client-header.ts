import {
  getModelProviderRequestRouteFacts,
  prepareModelProviderRequestRouteFacts,
  resolveProviderRequestHeadersAsync,
  type ProviderRequestCapability,
  type ProviderRequestTransport,
} from "openclaw/plugin-sdk/provider-http";
import { DEFAULT_GOOGLE_API_BASE_URL } from "./provider-policy.js";

type GoogleApiClientHeaderParams = {
  api?: string;
  baseUrl?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
  providerMetadataOwners?: Parameters<
    typeof resolveProviderRequestHeadersAsync
  >[0]["providerMetadataOwners"];
};

export async function prepareGoogleApiClientMetadata(params: GoogleApiClientHeaderParams = {}) {
  const model = await prepareModelProviderRequestRouteFacts({
    provider: "google",
    api: params.api ?? "google-generative-ai",
    baseUrl: params.baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL,
  });
  return getModelProviderRequestRouteFacts(model)?.providerMetadataOwners;
}

export async function resolveGoogleApiClientHeadersAsync(
  params?: GoogleApiClientHeaderParams,
): Promise<Record<string, string>> {
  return (
    (await resolveProviderRequestHeadersAsync({
      provider: "google",
      api: params?.api ?? "google-generative-ai",
      baseUrl: params?.baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL,
      capability: params?.capability ?? "other",
      transport: params?.transport ?? "http",
      providerMetadataOwners: params?.providerMetadataOwners,
    })) ?? {}
  );
}
