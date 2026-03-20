import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";
import { runSearxngSearch } from "./searxng-client.js";

const SearxngSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    max_results: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-25).",
        minimum: 1,
        maximum: 25,
      }),
    ),
    language: Type.Optional(
      Type.String({
        description:
          "Language/locale code for results (e.g. 'pt-PT', 'en-US', 'de-DE').",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createSearxngSearchTool(api: OpenClawPluginApi) {
  return {
    name: "web_search",
    label: "Web Search (SearXNG)",
    description:
      "Search the web using SearXNG — a privacy-respecting meta-search engine that aggregates results from multiple sources. No API key required.",
    parameters: SearxngSearchSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = typeof rawParams.query === "string" ? rawParams.query : "";
      if (!query) throw new Error("query is required");

      const maxResultsRaw = rawParams.max_results;
      const maxResults =
        typeof maxResultsRaw === "number" && Number.isFinite(maxResultsRaw)
          ? Math.floor(maxResultsRaw)
          : undefined;

      const languageRaw = rawParams.language;
      const language =
        typeof languageRaw === "string" && languageRaw.trim()
          ? languageRaw.trim()
          : undefined;

      const result = await runSearxngSearch({
        cfg: api.config,
        query,
        maxResults,
        language,
      });

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  };
}
