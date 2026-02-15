import type { Api, Model } from "@mariozechner/pi-ai";

/**
 * Check if a model targets the Anthropic Messages API.
 */
export function isAnthropicProvider(model: Model<Api> | undefined): boolean {
  if (!model) {
    return false;
  }
  return (model as { api?: unknown }).api === "anthropic-messages";
}
