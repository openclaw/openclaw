import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "q", "gl", "hl",
  "topic_token", "publication_token", "section_token", "story_token", "so",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const results = Array.isArray(raw.news_results)
    ? (raw.news_results as unknown[]).slice(0, maxCount)
    : [];
  return {
    engine: "google_news",
    results,
    menu_links: raw.menu_links ?? [],
    related_topics: raw.related_topics ?? [],
    related_publications: raw.related_publications ?? [],
  };
}

export function createSerpApiNewsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_news",
    label: "SerpApi Google News",
    description:
      "Search Google News for recent articles. Returns headlines, sources, dates, and URLs. " +
      "Use topic_token/publication_token for browsing topics or publishers. " +
      "so: 0=relevance (default), 1=date. Time filter via q: e.g. q='coffee when:1d'.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "News search query. Use 'when:1d' for time filter, e.g. 'AI when:7d'." },
        count: { type: "number", description: "Number of results (1-10).", minimum: 1, maximum: 10 },
        gl: { type: "string", description: "Country code (e.g. us, de, ua)." },
        hl: { type: "string", description: "Language code override (e.g. en, de, uk)." },
        so: {
          type: "number",
          description: "Sort: 0=relevance (default), 1=date.",
          enum: [0, 1],
        },
        topic_token: { type: "string", description: "Google News topic token (from menu_links[].topic_token)." },
        publication_token: { type: "string", description: "Publisher token (from related_publications[].publication_token)." },
        section_token: { type: "string", description: "Sub-section token. Use with topic_token or publication_token." },
        story_token: { type: "string", description: "Story token for full coverage of a specific story." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const cfg = resolveToolConfig(api, ctx);
      const count = readNumberParam(args, "count", { integer: true }) ?? 5;
      const raw = await callSerpApi({
        cfg,
        engine: "google_news",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query"),
          gl: readStringParam(args, "gl") ?? undefined,
          hl: readStringParam(args, "hl") ?? undefined,
          so: readNumberParam(args, "so", { integer: true }) ?? undefined,
          topic_token: readStringParam(args, "topic_token") ?? undefined,
          publication_token: readStringParam(args, "publication_token") ?? undefined,
          section_token: readStringParam(args, "section_token") ?? undefined,
          story_token: readStringParam(args, "story_token") ?? undefined,
        },
      });
      return extract(raw, count);
    },
  };
}

