import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.ts";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.ts";

const ALLOWED_PARAMS = ["profile_id", "next_page_token", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "instagram_profile",
    profile: raw.profile_data ?? raw.profile ?? null,
    posts: raw.posts ?? raw.recent_posts ?? [],
    reels: raw.reels ?? [],
    highlights: raw.highlights ?? [],
    related_profiles: raw.related_profiles ?? [],
    serpapi_pagination: raw.serpapi_pagination ?? null,
  };
}

export function createSerpApiInstagramProfileTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_instagram_profile",
    label: "SerpApi Instagram Profile",
    description:
      "Fetch a public Instagram profile via SerpApi. " +
      "Returns profile details, posts, reels, highlights, and related profiles. " +
      "Use next_page_token from serpapi_pagination to paginate posts.",
    parameters: {
      type: "object",
      properties: {
        profile_id: {
          type: "string",
          description:
            "Instagram profile ID from the profile URL. " +
            "For https://www.instagram.com/serpapicom, use 'serpapicom'.",
        },
        next_page_token: {
          type: "string",
          description:
            "Pagination token from serpapi_pagination.next_page_token returned in a previous response.",
        },
      },
      required: ["profile_id"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "instagram_profile",
        allowedParams: ALLOWED_PARAMS,
        params: {
          profile_id: readStringParam(args, "profile_id", { required: true }),
          next_page_token: readStringParam(args, "next_page_token") ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
