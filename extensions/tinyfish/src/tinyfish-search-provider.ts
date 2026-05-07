import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const TINYFISH_CREDENTIAL_PATH = "plugins.entries.tinyfish.config.webSearch.apiKey";

type TinyFishClientModule = typeof import("./tinyfish-client.js");

let clientModulePromise: Promise<TinyFishClientModule> | undefined;

function loadClientModule(): Promise<TinyFishClientModule> {
  clientModulePromise ??= import("./tinyfish-client.js");
  return clientModulePromise;
}

const GenericTinyFishSearchSchema = {
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

export function createTinyFishWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "tinyfish",
    label: "TinyFish Search",
    hint: "Fast web search with structured results",
    onboardingScopes: ["text-inference"],
    credentialLabel: "TinyFish API key",
    envVars: ["TINYFISH_API_KEY"],
    placeholder: "tf_live_...",
    signupUrl: "https://tinyfish.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/tinyfish",
    autoDetectOrder: 65,
    credentialPath: TINYFISH_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: TINYFISH_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "tinyfish" },
      configuredCredential: { pluginId: "tinyfish" },
      selectionPluginId: "tinyfish",
    }),
    createTool: (ctx) => ({
      description: "Search the web using TinyFish. Returns structured results with snippets.",
      parameters: GenericTinyFishSearchSchema,
      execute: async (args) => {
        const { runTinyFishSearch } = await loadClientModule();
        return await runTinyFishSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: typeof args.count === "number" ? args.count : undefined,
        });
      },
    }),
  };
}
