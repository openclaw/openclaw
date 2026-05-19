import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = ["v", "language_code", "title", "type", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "youtube_video_transcript",
    video_id: raw.video_id ?? null,
    title: raw.title ?? null,
    language_code: raw.language_code ?? null,
    transcript: raw.transcript ?? [],
  };
}

export function createSerpApiYouTubeTranscriptTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_youtube_transcript",
    label: "SerpApi YouTube Video Transcript",
    description:
      "Fetch the transcript of a YouTube video via SerpApi. " +
      "Returns timestamped transcript segments. " +
      "Use language_code to request a specific language; falls back to the first available if not found.",
    parameters: {
      type: "object",
      properties: {
        v: {
          type: "string",
          description:
            "YouTube video ID from the URL (e.g. 'dQw4w9WgXcQ' from youtube.com/watch?v=dQw4w9WgXcQ or youtu.be/dQw4w9WgXcQ).",
        },
        language_code: {
          type: "string",
          description:
            "Language code for the transcript (e.g. en, es-ES, zh-Hans). Defaults to en. Falls back to first available if the requested language is unavailable.",
        },
        title: {
          type: "string",
          description: "Specific transcript title to select (e.g. 'Twitch Chat - Simple').",
        },
        type: {
          type: "string",
          description:
            "Transcript type filter. Use 'asr' for auto-generated (automatic speech recognition) transcripts.",
        },
      },
      required: ["v"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "youtube_video_transcript",
        allowedParams: ALLOWED_PARAMS,
        params: {
          v: readStringParam(args, "v", { required: true }),
          language_code: readStringParam(args, "language_code") ?? undefined,
          title: readStringParam(args, "title") ?? undefined,
          type: readStringParam(args, "type") ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
