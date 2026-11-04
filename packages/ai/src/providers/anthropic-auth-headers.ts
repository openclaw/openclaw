import { getAiTransportHost } from "../host.js";
import type { ModelRequestHeaders } from "../types.js";

/**
 * Messages API version both Anthropic transports send. SDK 1.x defaults to 2026-10-21, which
 * rejects sampling parameters that Claude models before 4.7 accept and is unavailable for those
 * models on Bedrock, so moving to it is a separate product change.
 */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** Inspect resolved credential shape for auth routing without exposing its value. */
export function isAnthropicOAuthApiKey(apiKey: unknown): boolean {
  return (
    typeof apiKey === "string" &&
    getAiTransportHost().resolveSecretSentinel(apiKey).includes("sk-ant-oat")
  );
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
