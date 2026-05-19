import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = ["q", "gl", "hl", "cp", "client", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "google_autocomplete",
    suggestions: raw.suggestions ?? [],
    verbatim_relevance: raw.verbatim_relevance ?? null,
  };
}

export function createSerpApiAutocompleteTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_autocomplete",
    label: "SerpApi Google Autocomplete",
    description:
      "Fetch Google search autocomplete suggestions for a partial query via SerpApi. " +
      "Returns a ranked list of query completions with relevance scores. " +
      "Useful for query expansion, spell suggestions, and search UX features.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Partial search query to get completions for.",
        },
        gl: {
          type: "string",
          description: "Two-letter country code (e.g. us, gb, fr).",
        },
        hl: {
          type: "string",
          description: "Two-letter language code (e.g. en, es, fr).",
        },
        cp: {
          type: "number",
          description: "Cursor position in the query string (0-based). Defaults to end of query.",
          minimum: 0,
        },
        client: {
          type: "string",
          description:
            "Autocomplete client (e.g. chrome, safari, firefox-b-d, youtube). Affects suggestion style.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "google_autocomplete",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          gl: readStringParam(args, "gl") ?? undefined,
          hl: readStringParam(args, "hl") ?? undefined,
          cp: readNumberParam(args, "cp", { integer: true }) ?? undefined,
          client: readStringParam(args, "client") ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
