import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";
import { runComposioSearch } from "./composio-client.js";
import { resolveConfiguredComposioApiKey, setComposioApiKey } from "./config.js";

const COMPOSIO_CREDENTIAL_PATH = "plugins.entries.composio.config.webSearch.apiKey";

const ComposioSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createComposioWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "composio",
    label: "Composio Search",
    hint: "Structured results via Composio Search",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Composio API key",
    envVars: ["COMPOSIO_API_KEY"],
    placeholder: "ak_...",
    signupUrl: "https://app.composio.dev/",
    docsUrl: "https://docs.composio.dev",
    autoDetectOrder: 80,
    credentialPath: COMPOSIO_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: COMPOSIO_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "composio" },
      configuredCredential: { pluginId: "composio" },
      selectionPluginId: "composio",
    }),
    inactiveSecretPaths: ["tools.web.search.composioApiKey"],
    getConfiguredCredentialValue: resolveConfiguredComposioApiKey,
    setConfiguredCredentialValue: setComposioApiKey,
    createTool: (ctx) => ({
      description:
        "Search the web using Composio Search. Returns titles, URLs, and snippets for fast research.",
      parameters: ComposioSearchSchema,
      execute: async (args) => {
        return await runComposioSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: typeof args.count === "number" ? args.count : undefined,
        });
      },
    }),
  };
}
