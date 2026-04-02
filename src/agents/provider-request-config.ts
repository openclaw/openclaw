import type { Api } from "@mariozechner/pi-ai";
import type { ModelDefinitionConfig } from "../config/types.js";
import type {
  ProviderRequestCapability,
  ProviderRequestPolicyResolution,
  ProviderRequestTransport,
} from "./provider-attribution.js";
import { resolveProviderRequestPolicy } from "./provider-attribution.js";

type RequestApi = Api | ModelDefinitionConfig["api"];

export type ResolvedProviderRequestAuthConfig = {
  mode: "provider-default" | "authorization-bearer";
  injectAuthorizationHeader: boolean;
};

export type ResolvedProviderRequestProxyConfig = {
  configured: false;
};

export type ResolvedProviderRequestTlsConfig = {
  configured: false;
};

export type ResolvedProviderRequestConfig = {
  api?: RequestApi;
  baseUrl?: string;
  headers?: Record<string, string>;
  auth: ResolvedProviderRequestAuthConfig;
  proxy: ResolvedProviderRequestProxyConfig;
  tls: ResolvedProviderRequestTlsConfig;
  policy: ProviderRequestPolicyResolution;
};

export function mergeProviderRequestHeaders(
  ...headerSets: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  let merged: Record<string, string> | undefined;
  for (const headers of headerSets) {
    if (!headers) {
      continue;
    }
    merged = {
      ...merged,
      ...headers,
    };
  }
  return merged && Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveProviderRequestConfig(params: {
  provider: string;
  api?: RequestApi;
  baseUrl?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
  discoveredHeaders?: Record<string, string>;
  providerHeaders?: Record<string, string>;
  modelHeaders?: Record<string, string>;
  authHeader?: boolean;
}): ResolvedProviderRequestConfig {
  const policy = resolveProviderRequestPolicy({
    provider: params.provider,
    api: params.api,
    baseUrl: params.baseUrl,
    capability: params.capability ?? "llm",
    transport: params.transport ?? "http",
  });

  return {
    api: params.api,
    baseUrl: params.baseUrl,
    headers: mergeProviderRequestHeaders(
      params.discoveredHeaders,
      params.providerHeaders,
      params.modelHeaders,
    ),
    auth: {
      mode: params.authHeader ? "authorization-bearer" : "provider-default",
      injectAuthorizationHeader: params.authHeader === true,
    },
    // These slots are intentionally internal-first. Future provider request
    // policy work can populate them without reshaping existing callers again.
    proxy: { configured: false },
    tls: { configured: false },
    policy,
  };
}
