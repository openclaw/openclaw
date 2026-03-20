import { Type } from "@sinclair/typebox";

import {
  enablePluginInConfig,
  getScopedCredentialValue,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { runDdgSearch } from "./ddg-client.js";

const DdgSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-25).",
        minimum: 1,
        maximum: 25,
      }),
    ),
    region: Type.Optional(
      Type.String({
        description:
          "DuckDuckGo region code for localized results (e.g., 'us-en', 'br-pt', 'de-de', 'uk-en').",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createDdgWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "duckduckgo",
    label: "DuckDuckGo Search",
    hint: "Free web search — no API key required",
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://duckduckgo.com/",
    docsUrl: "https://docs.openclaw.ai/tools/duckduckgo",
    autoDetectOrder: 100,
    credentialPath: "",
    inactiveSecretPaths: [],
    getCredentialValue: (searchConfig) =>
      getScopedCredentialValue(searchConfig, "duckduckgo") ??
      "duckduckgo-no-key-needed",
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "duckduckgo", value),
    getConfiguredCredentialValue: (_config) => "duckduckgo-no-key-needed",
    setConfiguredCredentialValue: (_configTarget, _value) => {
      // DuckDuckGo requires no API key — nothing to store
    },
    applySelectionConfig: (config) =>
      enablePluginInConfig(config, "duckduckgo").config,
    createTool: (ctx) => ({
      description:
        "Search the web using DuckDuckGo. Free, no API key required. Returns titles, URLs, and snippets. Supports region-specific results.",
      parameters: DdgSearchSchema,
      execute: async (args) =>
        await runDdgSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          maxResults: typeof args.count === "number" ? args.count : undefined,
          region: typeof args.region === "string" ? args.region : undefined,
        }),
    }),
  };
}
