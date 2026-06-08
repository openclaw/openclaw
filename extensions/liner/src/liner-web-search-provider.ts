import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createLinerWebSearchProviderBase } from "./liner-web-search-provider.shared.js";

const LINER_MAX_SEARCH_COUNT = 50;

type LinerWebSearchRuntime = typeof import("./liner-web-search-provider.runtime.js");

let linerWebSearchRuntimePromise: Promise<LinerWebSearchRuntime> | undefined;

function loadLinerWebSearchRuntime(): Promise<LinerWebSearchRuntime> {
  linerWebSearchRuntimePromise ??= import("./liner-web-search-provider.runtime.js");
  return linerWebSearchRuntimePromise;
}

// Liner Search exposes a single-query `web_search` shape: a keyword/question
// `query` plus an optional result `count`. This matches OpenClaw's generic
// `web_search` contract directly (no provider-specific richer schema needed).
export const LinerSearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The search query — a question or keyword phrase.",
    },
    count: {
      type: "integer",
      description: "Number of results to return (1-50).",
      minimum: 1,
      maximum: LINER_MAX_SEARCH_COUNT,
    },
  },
  required: ["query"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createLinerWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createLinerWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web with Liner. Returns ranked, source-grounded results optimized for AI agents, " +
        "each with a title, URL, and excerpt. Pass a natural-language question or keyword phrase as `query`.",
      parameters: LinerSearchSchema,
      execute: async (args) => {
        const { executeLinerWebSearchProviderTool } = await loadLinerWebSearchRuntime();
        return await executeLinerWebSearchProviderTool(ctx, args);
      },
    }),
  };
}
