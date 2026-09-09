import { resolveProviderEndpoint } from "openclaw/plugin-sdk/provider-http";
import { resolveAnthropicVertexRegion } from "./region.js";

/** Extract a Vertex region from a provider base URL when possible. */
export function resolveAnthropicVertexRegionFromBaseUrl(baseUrl?: string): string | undefined {
  const endpoint = resolveProviderEndpoint(baseUrl);
  return endpoint.endpointClass === "google-vertex" ? endpoint.googleVertexRegion : undefined;
}

/** Resolve the client region from model base URL first, then env fallback. */
export function resolveAnthropicVertexClientRegion(params?: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return (
    resolveAnthropicVertexRegionFromBaseUrl(params?.baseUrl) ||
    resolveAnthropicVertexRegion(params?.env)
  );
}
