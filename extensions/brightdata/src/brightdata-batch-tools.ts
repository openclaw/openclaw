import { Type } from "@sinclair/typebox";
import {
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { runBrightDataScrape, runBrightDataSearch } from "./brightdata-client.js";

function optionalStringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Optional(
    Type.Unsafe<T[number]>({
      type: "string",
      enum: [...values],
      ...options,
    }),
  );
}

const MAX_BATCH_ITEMS = 5;

const BrightDataBatchSearchQuerySchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    engine: optionalStringEnum(["google", "bing", "yandex"] as const, {
      description: 'Search engine ("google", "bing", or "yandex"). Default: google.',
    }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        description: "Pagination cursor for the next page.",
      }),
    ),
    geo_location: Type.Optional(
      Type.String({
        description: '2-letter country code for geo-targeted results, for example "us" or "uk".',
        minLength: 2,
        maxLength: 2,
      }),
    ),
  },
  { additionalProperties: false },
);

const BrightDataSearchBatchToolSchema = Type.Object(
  {
    queries: Type.Array(BrightDataBatchSearchQuerySchema, {
      description: "Array of search requests to run in parallel (1-5).",
      minItems: 1,
      maxItems: MAX_BATCH_ITEMS,
    }),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "Timeout in seconds for each Bright Data search request.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

const BrightDataScrapeBatchToolSchema = Type.Object(
  {
    urls: Type.Array(Type.String({ description: "HTTP or HTTPS URL to scrape via Bright Data." }), {
      description: "Array of URLs to scrape in parallel (1-5).",
      minItems: 1,
      maxItems: MAX_BATCH_ITEMS,
    }),
    extractMode: optionalStringEnum(["markdown", "text", "html"] as const, {
      description: 'Extraction mode ("markdown", "text", or "html"). Default: markdown.',
    }),
    maxChars: Type.Optional(
      Type.Number({
        description: "Maximum characters to return for each result.",
        minimum: 100,
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "Timeout in seconds for each Bright Data scrape request.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

type SearchBatchQuery = {
  query: string;
  engine?: "google" | "bing" | "yandex";
  count?: number;
  cursor?: string;
  geoLocation?: string;
};

function readSearchBatchQueries(rawParams: Record<string, unknown>): SearchBatchQuery[] {
  const rawQueries = rawParams.queries;
  if (!Array.isArray(rawQueries) || rawQueries.length === 0) {
    throw new ToolInputError("queries required");
  }
  if (rawQueries.length > MAX_BATCH_ITEMS) {
    throw new ToolInputError(`queries must contain at most ${MAX_BATCH_ITEMS} items`);
  }
  return rawQueries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToolInputError(`queries[${index}] must be an object`);
    }
    const params = entry as Record<string, unknown>;
    const query = readStringParam(params, "query", {
      required: true,
      label: `queries[${index}].query`,
    });
    const engineRaw = readStringParam(params, "engine", {
      label: `queries[${index}].engine`,
    });
    const engine =
      engineRaw === "google" || engineRaw === "bing" || engineRaw === "yandex"
        ? engineRaw
        : undefined;
    const count = readNumberParam(params, "count", {
      integer: true,
      label: `queries[${index}].count`,
    });
    const cursor = readStringParam(params, "cursor", {
      label: `queries[${index}].cursor`,
    });
    const geoLocation = readStringParam(params, "geo_location", {
      label: `queries[${index}].geo_location`,
    });

    return {
      query,
      engine,
      count,
      cursor,
      geoLocation,
    };
  });
}

function readScrapeBatchUrls(rawParams: Record<string, unknown>): string[] {
  const urls = readStringArrayParam(rawParams, "urls", { required: true });
  if (urls.length > MAX_BATCH_ITEMS) {
    throw new ToolInputError(`urls must contain at most ${MAX_BATCH_ITEMS} items`);
  }
  return urls;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export function createBrightDataBatchTools(api: OpenClawPluginApi) {
  return [
    {
      name: "brightdata_search_batch",
      label: "Bright Data Search Batch",
      description:
        "Run up to 5 Bright Data search requests in parallel. Returns per-query results and preserves item-level failures.",
      parameters: BrightDataSearchBatchToolSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const queries = readSearchBatchQueries(rawParams);
        const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", {
          integer: true,
        });

        const settled = await Promise.allSettled(
          queries.map((query) =>
            runBrightDataSearch({
              cfg: api.config,
              query: query.query,
              engine: query.engine,
              count: query.count,
              cursor: query.cursor,
              geoLocation: query.geoLocation,
              timeoutSeconds,
            }),
          ),
        );

        const results = settled.map((entry, index) =>
          entry.status === "fulfilled"
            ? {
                index,
                query: queries[index]?.query ?? "",
                engine: queries[index]?.engine ?? "google",
                ok: true,
                result: entry.value,
              }
            : {
                index,
                query: queries[index]?.query ?? "",
                engine: queries[index]?.engine ?? "google",
                ok: false,
                error: readErrorMessage(entry.reason),
              },
        );

        return jsonResult({
          total: queries.length,
          succeeded: results.filter((entry) => entry.ok).length,
          failed: results.filter((entry) => !entry.ok).length,
          results,
        });
      },
    },
    {
      name: "brightdata_scrape_batch",
      label: "Bright Data Scrape Batch",
      description:
        "Scrape up to 5 URLs in parallel through Bright Data. Returns per-URL results and preserves item-level failures.",
      parameters: BrightDataScrapeBatchToolSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const urls = readScrapeBatchUrls(rawParams);
        const extractModeRaw = readStringParam(rawParams, "extractMode");
        const extractMode =
          extractModeRaw === "text" || extractModeRaw === "html" ? extractModeRaw : "markdown";
        const maxChars = readNumberParam(rawParams, "maxChars", { integer: true });
        const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", {
          integer: true,
        });

        const settled = await Promise.allSettled(
          urls.map((url) =>
            runBrightDataScrape({
              cfg: api.config,
              url,
              extractMode,
              maxChars,
              timeoutSeconds,
            }),
          ),
        );

        const results = settled.map((entry, index) =>
          entry.status === "fulfilled"
            ? {
                index,
                url: urls[index] ?? "",
                ok: true,
                result: entry.value,
              }
            : {
                index,
                url: urls[index] ?? "",
                ok: false,
                error: readErrorMessage(entry.reason),
              },
        );

        return jsonResult({
          total: urls.length,
          succeeded: results.filter((entry) => entry.ok).length,
          failed: results.filter((entry) => !entry.ok).length,
          results,
        });
      },
    },
  ];
}
