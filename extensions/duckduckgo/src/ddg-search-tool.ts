import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";
import { runDdgSearch } from "./ddg-client.js";

const DdgSearchToolSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    max_results: Type.Optional(
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

export function createDdgSearchTool(api: OpenClawPluginApi) {
  return {
    name: "web_search",
    label: "Web Search (DuckDuckGo)",
    description:
      "Search the web using DuckDuckGo. Free, no API key required. Supports region-specific results via region codes.",
    parameters: DdgSearchToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = typeof rawParams.query === "string" ? rawParams.query : "";
      if (!query) throw new Error("query is required");
      const maxResultsRaw = rawParams.max_results;
      const maxResults =
        typeof maxResultsRaw === "number" && Number.isFinite(maxResultsRaw)
          ? Math.floor(maxResultsRaw)
          : undefined;
      const regionRaw = rawParams.region;
      const region = typeof regionRaw === "string" && regionRaw.trim() ? regionRaw.trim() : undefined;

      const result = await runDdgSearch({
        cfg: api.config,
        query,
        maxResults,
        region,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  };
}
