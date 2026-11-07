import { isXaiGrokProxyBaseUrl } from "../provider-catalog.js";

// Grok's subscription proxy requires this CLI compatibility floor, not the OpenClaw version.
export const XAI_GROK_CLIENT_VERSION = "1.0.13";

/** Shared native subscription identity for model streams and Responses tools. */
export function buildXaiGrokSubscriptionHeaders(
  baseUrl: string | undefined,
  model: string,
): Record<string, string> | undefined {
  if (!isXaiGrokProxyBaseUrl(baseUrl)) {
    return undefined;
  }
  return {
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
    "x-grok-model-override": model,
  };
}
