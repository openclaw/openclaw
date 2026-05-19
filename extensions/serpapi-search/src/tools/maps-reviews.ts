import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  readNumberParam,
  readStringParam,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "data_id",
  "place_id",
  "hl",
  "sort_by",
  "topic_id",
  "query",
  "num",
  "next_page_token",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  const reviews = Array.isArray(raw.reviews)
    ? (raw.reviews as Record<string, unknown>[]).map((r) => ({
        position: r.position,
        rating: r.rating,
        date: r.date,
        iso_date: r.iso_date,
        snippet: typeof r.snippet === "string" ? wrapWebContent(r.snippet) : (r.snippet ?? null),
        user: r.user ?? null,
        details: r.details ?? null,
        likes: r.likes,
        images: r.images ?? [],
      }))
    : [];
  return {
    engine: "google_maps_reviews",
    place_info: raw.place_info ?? null,
    topics: raw.topics ?? [],
    reviews,
    serpapi_pagination: raw.serpapi_pagination ?? null,
  };
}

export function createSerpApiMapsReviewsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_maps_reviews",
    label: "SerpApi Google Maps Reviews",
    description:
      "Fetch reviews for a place on Google Maps via SerpApi. " +
      "Requires either data_id (from serpapi_maps results) or place_id. " +
      "Returns place info, review topics, and individual reviews with ratings, snippets, and user details.",
    parameters: {
      type: "object",
      properties: {
        data_id: {
          type: "string",
          description:
            "Google Maps data ID for the place. Obtain from serpapi_maps results. Either data_id or place_id is required.",
        },
        place_id: {
          type: "string",
          description: "Google Maps place ID. Either place_id or data_id is required.",
        },
        hl: {
          type: "string",
          description: "Two-letter language code for results (e.g. en, de, fr). Defaults to en.",
        },
        sort_by: {
          type: "string",
          enum: ["qualityScore", "newestFirst", "ratingHigh", "ratingLow"],
          description:
            "Sort order for reviews. qualityScore = most relevant (default), newestFirst = most recent, ratingHigh/ratingLow = by rating.",
        },
        topic_id: {
          type: "string",
          description:
            "Filter reviews by topic ID (from the topics array in the response). Cannot be used with query.",
        },
        query: {
          type: "string",
          description: "Text query to filter reviews. Cannot be used with topic_id.",
        },
        num: {
          type: "number",
          description:
            "Maximum number of reviews to return (1–20, default 10). Cannot be used on the initial page without next_page_token/topic_id/query.",
          minimum: 1,
          maximum: 20,
        },
        next_page_token: {
          type: "string",
          description:
            "Pagination token from serpapi_pagination.next_page_token to fetch the next page.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const dataId = readStringParam(args, "data_id");
      const placeId = readStringParam(args, "place_id");
      if (!dataId && !placeId) {
        throw new Error("serpapi_maps_reviews: either data_id or place_id is required");
      }
      if (dataId && placeId) {
        throw new Error("serpapi_maps_reviews: provide either data_id or place_id, not both");
      }
      const topicId = readStringParam(args, "topic_id");
      const query = readStringParam(args, "query");
      if (topicId && query) {
        throw new Error("serpapi_maps_reviews: topic_id and query are mutually exclusive");
      }
      const raw = await callSerpApi({
        cfg,
        engine: "google_maps_reviews",
        allowedParams: ALLOWED_PARAMS,
        params: {
          data_id: dataId ?? undefined,
          place_id: placeId ?? undefined,
          hl: readStringParam(args, "hl") ?? undefined,
          sort_by: readStringParam(args, "sort_by") ?? undefined,
          topic_id: topicId ?? undefined,
          query: query ?? undefined,
          num: readNumberParam(args, "num", { integer: true }) ?? undefined,
          next_page_token: readStringParam(args, "next_page_token") ?? undefined,
        },
        signal,
      });
      return extract(raw);
    },
  };
}
