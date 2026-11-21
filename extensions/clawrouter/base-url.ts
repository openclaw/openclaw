const CLAWROUTER_DEFAULT_BASE_URL = "https://clawrouter.openclaw.ai";

export function normalizeClawRouterRootUrl(baseUrl: string | undefined): string {
  const normalized = (baseUrl?.trim() || CLAWROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

export function normalizeClawRouterApiBaseUrl(baseUrl: string | undefined): string {
  return `${normalizeClawRouterRootUrl(baseUrl)}/v1`;
}
