import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";
import { resolveDeepSeekModelKeyFallback } from "./model-credential.js";

const CREDENTIAL_PATH = "plugins.entries.deepseek.config.webSearch.apiKey";
const loadRuntime = createLazyRuntimeModule(() => import("./web-search-provider.runtime.js"));

const DeepSeekSearchSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Search query, including any search operators.",
    },
    count: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description: "Number of results (1-10; default 5).",
    },
  },
};

export function createDeepSeekWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "deepseek",
    label: "DeepSeek",
    hint: "Structured search results from DeepSeek's search engine",
    onboardingScopes: ["text-inference"],
    credentialLabel: "DeepSeek API key",
    envVars: ["DEEPSEEK_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://docs.openclaw.ai/providers/deepseek#web-search",
    autoDetectOrder: 80,
    credentialPath: CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "deepseek" },
      configuredCredential: { pluginId: "deepseek" },
      selectionPluginId: "deepseek",
    }),
    getConfiguredCredentialFallback: resolveDeepSeekModelKeyFallback,
    createTool: (ctx) => ({
      description:
        "Search the web using DeepSeek. Returns titles, URLs, and model-oriented summaries. Queries support site:, -site:, lang:, after:, before:, and quoted phrases; maximum 128 Unicode characters.",
      parameters: DeepSeekSearchSchema,
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();
        const { executeDeepSeekSearch } = await loadRuntime();
        return executeDeepSeekSearch(ctx, args, context?.signal);
      },
    }),
  };
}
