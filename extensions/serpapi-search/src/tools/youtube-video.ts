import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = ["v", "gl", "hl", "next_page_token", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "youtube_video",
    title: raw.title ?? null,
    thumbnail: raw.thumbnail ?? null,
    channel: raw.channel ?? null,
    views: raw.extracted_views ?? null,
    likes: raw.extracted_likes ?? null,
    published_date: raw.published_date ?? null,
    description: raw.description ?? null,
    chapters: raw.chapters ?? [],
    related_videos: raw.related_videos ?? [],
    related_videos_next_page_token: raw.related_videos_next_page_token ?? null,
    end_screen_videos: raw.end_screen_videos ?? [],
    comments_next_page_token: raw.comments_next_page_token ?? null,
    comments_sorting_token: raw.comments_sorting_token ?? [],
    transcript: raw.transcript ?? null,
  };
}

export function createSerpApiYouTubeVideoTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_youtube_video",
    label: "SerpApi YouTube Video",
    description:
      "Fetch metadata for a YouTube video via SerpApi: title, description, channel, views, likes, chapters, related videos, and comment pagination tokens. " +
      "Use next_page_token to paginate related videos or comments. " +
      "Use serpapi_youtube_transcript to get the full transcript.",
    parameters: {
      type: "object",
      properties: {
        v: {
          type: "string",
          description: "YouTube video ID (e.g. 'dQw4w9WgXcQ' from youtube.com/watch?v=dQw4w9WgXcQ).",
        },
        hl: {
          type: "string",
          description: "Two-letter language code for the response (e.g. en, de, fr).",
        },
        gl: {
          type: "string",
          description: "Two-letter country code (e.g. us, gb, fr).",
        },
        next_page_token: {
          type: "string",
          description:
            "Pagination token for related videos, comments, or replies. " +
            "Use related_videos_next_page_token, comments_next_page_token, comments_sorting_token.token, or replies_next_page_token from a previous response.",
        },
      },
      required: ["v"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "youtube_video",
        allowedParams: ALLOWED_PARAMS,
        params: {
          v: readStringParam(args, "v", { required: true }),
          hl: readStringParam(args, "hl") ?? undefined,
          gl: readStringParam(args, "gl") ?? undefined,
          next_page_token: readStringParam(args, "next_page_token") ?? undefined,
        },
        signal,
      });
      return extract(raw);
    },
  };
}
