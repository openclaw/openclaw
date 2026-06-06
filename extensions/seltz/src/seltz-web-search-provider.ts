import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createSeltzWebSearchProviderBase } from "./seltz-web-search-provider.shared.js";

const SELTZ_MAX_SEARCH_COUNT = 10;

type SeltzWebSearchRuntime = typeof import("./seltz-web-search-provider.runtime.js");

let seltzWebSearchRuntimePromise: Promise<SeltzWebSearchRuntime> | undefined;

function loadSeltzWebSearchRuntime(): Promise<SeltzWebSearchRuntime> {
  seltzWebSearchRuntimePromise ??= import("./seltz-web-search-provider.runtime.js");
  return seltzWebSearchRuntimePromise;
}

const SeltzSearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query string.",
    },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: SELTZ_MAX_SEARCH_COUNT,
    },
  },
  required: ["query"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createSeltzWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createSeltzWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using Seltz. Returns context-engineered web documents with source URLs for AI reasoning.",
      parameters: SeltzSearchSchema,
      execute: async (args) => {
        const { executeSeltzWebSearchProviderTool } = await loadSeltzWebSearchRuntime();
        return await executeSeltzWebSearchProviderTool(ctx, args);
      },
    }),
  };
}
