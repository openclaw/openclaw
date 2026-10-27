import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult } from "openclaw/plugin-sdk/provider-web-search";
import {
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { Type } from "typebox";

const PerplexityResearchToolSchema = Type.Object(
  {
    query: Type.String({ description: "Research question or task." }),
    effort: Type.Optional(
      Type.Union(
        [Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")],
        {
          description:
            "Research effort. Defaults to high; use xhigh only when maximum depth justifies extra time and cost.",
        },
      ),
    ),
    freshness: Type.Optional(
      Type.Union(
        [Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
        { description: "Optional recency filter for the Agent API web search." },
      ),
    ),
  },
  { additionalProperties: false },
);

type PerplexityToolContext = Pick<
  OpenClawPluginToolContext,
  "config" | "runtimeConfig" | "getRuntimeConfig"
>;

export function createPerplexityResearchTool(api: OpenClawPluginApi, ctx?: PerplexityToolContext) {
  return {
    name: "perplexity_research",
    label: "Perplexity Research",
    resultContentSource: "network" as const,
    description:
      "Research a question with Perplexity Agent API and return a cited synthesized answer. Choose effort explicitly when speed, depth, or cost matters.",
    parameters: PerplexityResearchToolSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const { executePerplexityResearch } =
        await import("./perplexity-web-search-provider.runtime.js");
      const config = ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api.config;
      const searchConfig = mergeScopedSearchConfig(
        // SAFETY: validated config narrows here; provider parsing validates the record's contents.
        config?.tools?.web?.search as Record<string, unknown> | undefined,
        "perplexity",
        resolveProviderWebSearchPluginConfig(config, "perplexity"),
      );
      return jsonResult(await executePerplexityResearch(args, searchConfig, signal));
    },
  };
}
