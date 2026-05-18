import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../tool-utils.js";

const ALLOWED_PARAMS = ["q", "gl", "hl", "location", "chips", "zero_trace"] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const results = Array.isArray(raw.jobs_results)
    ? (raw.jobs_results as unknown[]).slice(0, maxCount)
    : [];
  return { engine: "google_jobs", results };
}

export function createSerpApiJobsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_jobs",
    label: "SerpApi Google Jobs",
    description:
      "Search Google Jobs for job listings. Returns job titles, companies, locations, and description snippets. " +
      "chips filter: date_posted:today, employment_type:FULLTIME, etc.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Job search query, e.g. "software engineer remote".' },
        count: { type: "number", description: "Number of results (1-10).", minimum: 1, maximum: 10 },
        location: { type: "string", description: 'Location string, e.g. "New York, NY".' },
        chips: {
          type: "string",
          description: 'Filter chips, e.g. "date_posted:today" or "employment_type:FULLTIME".',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const cfg = resolveToolConfig(api, ctx);
      const count = readNumberParam(args, "count", { integer: true }) ?? 5;
      const raw = await callSerpApi({
        cfg,
        engine: "google_jobs",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          location: readStringParam(args, "location") ?? undefined,
          chips: readStringParam(args, "chips") ?? undefined,
        },
      });
      return extract(raw, count);
    },
  };
}
