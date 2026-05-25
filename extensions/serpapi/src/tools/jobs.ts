import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.ts";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.ts";

const ALLOWED_PARAMS = [
  "q",
  "gl",
  "hl",
  "location",
  "lrad",
  "uds",
  "next_page_token",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const results = Array.isArray(raw.jobs_results)
    ? (raw.jobs_results as unknown[]).slice(0, maxCount)
    : [];
  return {
    engine: "google_jobs",
    results,
    filters: raw.filters ?? [],
    serpapi_pagination: raw.serpapi_pagination ?? null,
  };
}

export function createSerpApiJobsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_jobs",
    label: "SerpApi Google Jobs",
    description:
      "Search Google Jobs for job listings. Returns job titles, companies, locations, salary, and description. " +
      "Use uds for filtering (values from filters[].parameters.uds in previous response).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Job search query, e.g. "software engineer remote".',
        },
        count: {
          type: "number",
          description: "Number of results (1-10).",
          minimum: 1,
          maximum: 10,
        },
        location: { type: "string", description: 'Location string, e.g. "New York, NY".' },
        lrad: { type: "number", description: "Search radius in kilometers." },
        uds: {
          type: "string",
          description: "Filter string from filters[].parameters.uds in a previous response.",
        },
        next_page_token: { type: "string", description: "Token for next page of results." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const count = readNumberParam(args, "count", { integer: true }) ?? 5;
      const raw = await callSerpApi({
        cfg,
        engine: "google_jobs",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          location: readStringParam(args, "location") ?? undefined,
          lrad: readNumberParam(args, "lrad") ?? undefined,
          uds: readStringParam(args, "uds") ?? undefined,
          next_page_token: readStringParam(args, "next_page_token") ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw, count));
    },
  };
}
