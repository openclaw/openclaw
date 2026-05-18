import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = ["profile_id", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "facebook_profile",
    profile: raw.profile ?? null,
    posts: raw.posts ?? [],
    photos: raw.photos ?? [],
    videos: raw.videos ?? [],
    about: raw.about ?? null,
  };
}

export function createSerpApiFacebookProfileTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_facebook_profile",
    label: "SerpApi Facebook Profile",
    description:
      "Fetch a public Facebook profile via SerpApi. " +
      "Returns profile info, posts, photos, videos, and about section. " +
      "Use the profile slug (e.g. Meta) or numeric ID from the profile URL.",
    parameters: {
      type: "object",
      properties: {
        profile_id: {
          type: "string",
          description:
            "Facebook profile ID or slug from the profile URL. " +
            "E.g. 'Meta' from facebook.com/Meta, or '100080376596424' from facebook.com/profile.php?id=100080376596424.",
        },
      },
      required: ["profile_id"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "facebook_profile",
        allowedParams: ALLOWED_PARAMS,
        params: {
          profile_id: readStringParam(args, "profile_id", { required: true }),
        },
        signal,
      });
      return extract(raw);
    },
  };
}
