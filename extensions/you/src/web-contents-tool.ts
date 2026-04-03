import { Type } from "@sinclair/typebox";
import { jsonResult, readNumberParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { runYouContents } from "./you-client.js";

const WebContentsSchema = Type.Object(
  {
    urls: Type.Array(Type.String({ description: "URL to extract content from." }), {
      description: "Array of URLs to fetch content from.",
      minItems: 1,
      maxItems: 20,
    }),
    formats: Type.Optional(
      Type.Array(
        Type.String({
          description: 'Content format: "html", "markdown", or "metadata".',
        }),
        {
          description: 'Output formats to include (default: ["markdown"]).',
        },
      ),
    ),
    crawl_timeout: Type.Optional(
      Type.Number({
        description: "Timeout in seconds for crawling each URL (1-60, default: 10).",
        minimum: 1,
        maximum: 60,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createWebContentsTool(api: OpenClawPluginApi) {
  return {
    name: "web_contents",
    label: "Web Contents",
    description:
      "Extract full webpage content from URLs. Returns clean markdown, HTML, and metadata. Use after web_search to deep-read specific pages, or to extract content from known URLs. Requires YDC_API_KEY.",
    parameters: WebContentsSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const urls = Array.isArray(rawParams.urls)
        ? (rawParams.urls as string[]).filter(Boolean)
        : [];

      if (urls.length === 0) {
        throw new Error("web_contents requires at least one URL.");
      }

      const formats = Array.isArray(rawParams.formats)
        ? (rawParams.formats as string[]).filter(Boolean)
        : undefined;

      const crawlTimeout = readNumberParam(rawParams, "crawl_timeout", { integer: true });

      return jsonResult(
        await runYouContents({
          cfg: api.config,
          urls,
          formats: formats?.length ? formats : undefined,
          crawlTimeout,
        }),
      );
    },
  };
}
