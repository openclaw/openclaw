import { Type } from "@sinclair/typebox";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { runBrightDataSearch } from "./brightdata-client.js";

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

const BrightDataSearchToolSchema = Type.Object(
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
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "Timeout in seconds for the Bright Data Search request.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createBrightDataSearchTool(api: OpenClawPluginApi) {
  return {
    name: "brightdata_search",
    label: "Bright Data Search",
    description:
      "Search the web using Bright Data SERP scraping. Supports Google, Bing, and Yandex with pagination and geo targeting.",
    parameters: BrightDataSearchToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = readStringParam(rawParams, "query", { required: true });
      const engineRaw = readStringParam(rawParams, "engine");
      const engine =
        engineRaw === "google" || engineRaw === "bing" || engineRaw === "yandex"
          ? engineRaw
          : undefined;
      const count = readNumberParam(rawParams, "count", { integer: true });
      const cursor = readStringParam(rawParams, "cursor");
      const geoLocation = readStringParam(rawParams, "geo_location");
      const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", {
        integer: true,
      });

      return jsonResult(
        await runBrightDataSearch({
          cfg: api.config,
          query,
          engine,
          count,
          cursor,
          geoLocation,
          timeoutSeconds,
        }),
      );
    },
  };
}
