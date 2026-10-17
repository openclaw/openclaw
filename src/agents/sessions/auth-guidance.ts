/**
 * Uses docs paths instead of provider-specific instructions so guidance stays correct across OAuth/API-key providers.
 */
import { join } from "node:path";
import { getDocsPath } from "../package-metadata.js";

const UNKNOWN_PROVIDER = "unknown";

function getProviderLoginHelp(): string {
  return [
    "Use /login to log into a provider via OAuth or API key. See:",
    `  ${join(getDocsPath(), "providers.md")}`,
    `  ${join(getDocsPath(), "models.md")}`,
  ].join("\n");
}

export function formatNoModelSelectedMessage(): string {
  return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
  const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
  return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
