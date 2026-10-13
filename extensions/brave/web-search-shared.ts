/**
 * Shared Brave Search provider metadata and credential lookup. Contract tests
 * and runtime provider creation both use this lightweight descriptor.
 */
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

const BRAVE_CREDENTIAL_PATH = "plugins.entries.brave.config.webSearch.apiKey";

export function resolveBraveMode(brave?: { mode?: unknown }): "web" | "llm-context" {
  return brave?.mode === "llm-context" ? "llm-context" : "web";
}

/** Build the common Brave provider metadata without the runtime tool executor. */
export function buildBraveWebSearchProviderBase(): Omit<WebSearchProviderPlugin, "createTool"> {
  return {
    id: "brave",
    label: "Brave Search",
    hint: "Structured results · country/language/time filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Brave Search API key",
    envVars: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    signupUrl: "https://brave.com/search/api/",
    docsUrl: "https://docs.openclaw.ai/tools/brave-search",
    autoDetectOrder: 10,
    credentialPath: BRAVE_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: BRAVE_CREDENTIAL_PATH,
      searchCredential: { type: "top-level" },
      configuredCredential: { pluginId: "brave" },
    }),
  };
}
