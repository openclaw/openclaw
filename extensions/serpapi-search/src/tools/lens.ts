import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "url", "hl", "country", "type", "q", "safe", "auto_crop", "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "google_lens",
    visual_matches: raw.visual_matches ?? [],
    exact_matches: raw.exact_matches ?? [],
    related_content: raw.related_content ?? [],
    knowledge_graph: raw.knowledge_graph ?? null,
    text_results: raw.text_results ?? [],
    ai_overview: raw.ai_overview ?? null,
  };
}

export function createSerpApiLensTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_lens",
    label: "SerpApi Google Lens",
    description:
      "Perform a Google Lens reverse image search via SerpApi. " +
      "Provide a public image URL to find visual matches, exact matches, related content, and knowledge graph info. " +
      "Use type to narrow results (all/products/visual_matches/exact_matches/about_this_image).",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public URL of the image to search with Google Lens.",
        },
        type: {
          type: "string",
          enum: ["all", "about_this_image", "products", "exact_matches", "visual_matches"],
          description: "Type of search to perform (default: all).",
        },
        q: {
          type: "string",
          description:
            "Optional search query to refine results. Only applicable when type is all, visual_matches, or products.",
        },
        hl: {
          type: "string",
          description: "Two-letter language code (e.g. en, de, fr).",
        },
        country: {
          type: "string",
          description: "Two-letter country code (e.g. us, fr, de).",
        },
        safe: {
          type: "string",
          enum: ["active", "off"],
          description: "Filter adult content. active = filter, off = show.",
        },
        auto_crop: {
          type: "boolean",
          description:
            "Whether Google auto-crops the image to focus on the detected area of interest (default: false). Not applicable for type=about_this_image.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "google_lens",
        allowedParams: ALLOWED_PARAMS,
        params: {
          url: readStringParam(args, "url", { required: true }),
          type: readStringParam(args, "type") ?? undefined,
          q: readStringParam(args, "q") ?? undefined,
          hl: readStringParam(args, "hl") ?? undefined,
          country: readStringParam(args, "country") ?? undefined,
          safe: readStringParam(args, "safe") ?? undefined,
          auto_crop:
            args.auto_crop === true || args.auto_crop === "true" ? "true" : undefined,
        },
        signal,
      });
      return extract(raw);
    },
  };
}
