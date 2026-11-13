import { getAiTransportHost } from "../host.js";
import type { ModelRequestHeaders } from "../types.js";

/** Beta flag Anthropic requires on API requests authenticated with an OAuth bearer token. */
export const ANTHROPIC_OAUTH_API_BETA = "oauth-2025-04-20";

/**
 * Inspect resolved credential shape for auth routing without exposing its value.
 * True only for subscription OAuth tokens; workload identity tokens share the
 * prefix but are classified by isAnthropicWorkloadIdentityApiKey.
 */
export function isAnthropicOAuthApiKey(apiKey: unknown): boolean {
  if (typeof apiKey !== "string") {
    return false;
  }
  const host = getAiTransportHost();
  const resolved = host.resolveSecretSentinel(apiKey);
  return resolved.includes("sk-ant-oat") && !host.isAnthropicWorkloadIdentityToken(resolved);
}

/** True for workload identity federation access tokens minted by the host. */
export function isAnthropicWorkloadIdentityApiKey(apiKey: unknown): boolean {
  if (typeof apiKey !== "string") {
    return false;
  }
  const host = getAiTransportHost();
  return host.isAnthropicWorkloadIdentityToken(host.resolveSecretSentinel(apiKey));
}

/** Adds the OAuth API beta to an anthropic-beta header value without duplicating it. */
export function withAnthropicOAuthApiBeta(betaHeader: string | null | undefined): string {
  const betas = (betaHeader ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);
  return betas.includes(ANTHROPIC_OAUTH_API_BETA)
    ? betas.join(",")
    : [...betas, ANTHROPIC_OAUTH_API_BETA].join(",");
}

export function usesFoundryBearerAuth(model: {
  provider?: string;
  authHeader?: boolean;
  headers?: ModelRequestHeaders;
}): boolean {
  return (
    model.provider === "microsoft-foundry" &&
    (model.authHeader === true ||
      Object.entries(model.headers ?? {}).some(
        ([key, value]) =>
          key.toLowerCase() === "authorization" &&
          value !== null &&
          /^bearer\s+\S+/i.test(value.trim()),
      ))
  );
}

export function omitFoundryBearerCredentialHeaders(
  headers?: ModelRequestHeaders,
): ModelRequestHeaders | undefined {
  if (!headers) {
    return undefined;
  }
  const next: ModelRequestHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "api-key") {
      continue;
    }
    next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
