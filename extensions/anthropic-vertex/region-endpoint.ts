import { resolveProviderEndpoint } from "openclaw/plugin-sdk/provider-http";
import { resolveAnthropicVertexRegion } from "./region.js";

export function resolveAnthropicVertexBaseUrl(env?: NodeJS.ProcessEnv): string {
  const region = resolveAnthropicVertexRegion(env);
  return region === "global"
    ? "https://aiplatform.googleapis.com"
    : region === "us" || region === "eu"
      ? `https://aiplatform.${region}.rep.googleapis.com`
      : `https://${region}-aiplatform.googleapis.com`;
}

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
