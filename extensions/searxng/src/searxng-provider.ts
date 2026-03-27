import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  getScopedCredentialValue,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  MAX_SEARXNG_COUNT,
  resolveSearXNGBaseUrl,
  resolveSearXNGCategories,
  resolveSearXNGCount,
  resolveSearXNGLang,
} from "./config.js";
import { runSearXNGSearch } from "./searxng-client.js";

const SearXNGSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: `Number of results to return (1–${MAX_SEARXNG_COUNT}, default: 10).`,
        minimum: 1,
        maximum: MAX_SEARXNG_COUNT,
      }),
    ),
    lang: Type.Optional(
      Type.String({
        description: "Language code for results (e.g., en, de, fr). Defaults to configured lang.",
      }),
    ),
    categories: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Category filter (e.g., ["general", "news"]).',
      }),
    ),
  },
  { additionalProperties: false },
);

export function createSearXNGWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "searxng",
    label: "SearXNG",
    hint: "Self-hosted metasearch engine — no API key required",
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed — configure baseUrl)",
    signupUrl: "https://docs.searxng.org/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 200,
    credentialPath: "",
    inactiveSecretPaths: [],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "searxng"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "searxng", value),
    applySelectionConfig: (config) => enablePluginInConfig(config, "searxng").config,
    createTool: (ctx) => ({
      description: `Search the web using your self-hosted SearXNG instance at ${resolveSearXNGBaseUrl(ctx.config)}. No API key required. Supports language and category filters.`,
      parameters: SearXNGSearchSchema,
      execute: async (args) =>
        await runSearXNGSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
          lang: readStringParam(args, "lang"),
          categories: readStringArrayParam(args, "categories"),
        }),
    }),
  };
}
