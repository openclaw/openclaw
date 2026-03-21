import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { runBrightDataSearch } from "./brightdata-client.js";

const GenericBrightDataSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

function getScopedCredentialValue(searchConfig?: Record<string, unknown>): unknown {
  const scoped = searchConfig?.brightdata;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return undefined;
  }
  return (scoped as Record<string, unknown>).apiKey;
}

function setScopedCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  value: unknown,
): void {
  const scoped = searchConfigTarget.brightdata;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    searchConfigTarget.brightdata = { apiKey: value };
    return;
  }
  (scoped as Record<string, unknown>).apiKey = value;
}

export function createBrightDataWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "brightdata",
    label: "Bright Data Search",
    hint: "SERP results via Google/Bing/Yandex with bot bypass",
    envVars: ["BRIGHTDATA_API_TOKEN"],
    placeholder: "...",
    signupUrl: "https://brightdata.com/",
    docsUrl: "https://docs.openclaw.ai/tools/brightdata",
    autoDetectOrder: 65,
    credentialPath: "plugins.entries.brightdata.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.brightdata.config.webSearch.apiKey"],
    getCredentialValue: getScopedCredentialValue,
    setCredentialValue: setScopedCredentialValue,
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "brightdata")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "brightdata", "apiKey", value);
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, "brightdata").config,
    createTool: (ctx) => ({
      description:
        "Search the web using Bright Data. Returns structured search results. Use brightdata_search for Bright Data-specific knobs like engine, cursor, or geo_location.",
      parameters: GenericBrightDataSearchSchema,
      execute: async (args) =>
        await runBrightDataSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: typeof args.count === "number" ? args.count : undefined,
        }),
    }),
  };
}
