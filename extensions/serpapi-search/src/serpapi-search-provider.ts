import {
  readNumberParam,
  readStringParam,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createSerpApiWebSearchProviderBase } from "./serpapi-search-provider.shared.js";

type SerpApiClientModule = typeof import("./serpapi-client.js");

let clientModulePromise: Promise<SerpApiClientModule> | undefined;

function loadClientModule(): Promise<SerpApiClientModule> {
  clientModulePromise ??= import("./serpapi-client.js");
  return clientModulePromise;
}

const ALLOWED_PARAMS = ["q", "gl", "hl", "tbs", "safe", "num", "zero_trace"] as const;

function extract(
  raw: Record<string, unknown>,
  maxCount: number,
): Record<string, unknown> {
  const organicResults = Array.isArray(raw.organic_results)
    ? (raw.organic_results as Record<string, unknown>[])
    : [];
  const answerBox = raw.answer_box as Record<string, unknown> | undefined;
  return {
    engine: "google",
    answer_box: answerBox
      ? (answerBox.answer ?? answerBox.snippet ?? answerBox.result ?? null)
      : null,
    results: organicResults.slice(0, maxCount).map((r) => ({
      title: r.title,
      url: r.link ?? null,
      snippet: typeof r.snippet === "string" ? wrapWebContent(r.snippet) : (r.snippet ?? null),
    })),
  };
}

const SerpApiGoogleSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
    gl: {
      type: "string",
      description: "Country code for Google Search (e.g. us, de, ua). Defaults to us.",
    },
    safe: {
      type: "string",
      description: 'SafeSearch level: "active" or "off".',
    },
  },
  required: ["query"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createSerpApiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createSerpApiWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using SerpApi (Google). Returns titles, URLs, and snippets with real-time results.",
      parameters: SerpApiGoogleSearchSchema,
      execute: async (args) => {
        const { callSerpApi: call } = await loadClientModule();
        const count = readNumberParam(args, "count", { integer: true }) ?? 5;
        const raw = await call({
          cfg: ctx.config,
          engine: "google",
          allowedParams: ALLOWED_PARAMS,
          params: {
            q: readStringParam(args, "query", { required: true }),
            num: count,
            gl: readStringParam(args, "gl") ?? "us",
            safe: readStringParam(args, "safe") ?? undefined,
          },
        });
        return extract(raw, count);
      },
    }),
  };
}
