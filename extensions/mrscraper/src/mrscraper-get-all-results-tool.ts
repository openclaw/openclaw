import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { runMrScraperGetAllResults } from "./mrscraper-client.js";

const MrScraperGetAllResultsSchema = Type.Object(
  {
    sortField: Type.Optional(
      Type.Unsafe<
        | "createdAt"
        | "updatedAt"
        | "id"
        | "type"
        | "url"
        | "status"
        | "error"
        | "tokenUsage"
        | "runtime"
      >({
        type: "string",
        enum: [
          "createdAt",
          "updatedAt",
          "id",
          "type",
          "url",
          "status",
          "error",
          "tokenUsage",
          "runtime",
        ],
        description: "Column to sort by.",
      }),
    ),
    sortOrder: Type.Optional(
      Type.Unsafe<"ASC" | "DESC">({
        type: "string",
        enum: ["ASC", "DESC"],
        description: 'Sort order: "ASC" or "DESC".',
      }),
    ),
    pageSize: Type.Optional(Type.Number({ description: "Page size.", minimum: 1 })),
    page: Type.Optional(Type.Number({ description: "Page number, starting from 1.", minimum: 1 })),
    search: Type.Optional(Type.String({ description: "Optional text search filter." })),
    dateRangeColumn: Type.Optional(
      Type.String({ description: "Optional date field to filter by." }),
    ),
    startAt: Type.Optional(Type.String({ description: "Optional ISO start timestamp." })),
    endAt: Type.Optional(Type.String({ description: "Optional ISO end timestamp." })),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "HTTP timeout in seconds for the API request.", minimum: 1 }),
    ),
  },
  { additionalProperties: false },
);

export function createMrScraperGetAllResultsTool(api: OpenClawPluginApi) {
  return {
    name: "mrscraper_get_all_results",
    label: "MrScraper Get All Results",
    description:
      "List MrScraper results with pagination, sorting, and optional search/date filtering.",
    parameters: MrScraperGetAllResultsSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) =>
      jsonResult(
        await runMrScraperGetAllResults({
          cfg: api.config,
          sortField: (() => {
            const value = readStringParam(rawParams, "sortField");
            return value === "createdAt" ||
              value === "updatedAt" ||
              value === "id" ||
              value === "type" ||
              value === "url" ||
              value === "status" ||
              value === "error" ||
              value === "tokenUsage" ||
              value === "runtime"
              ? value
              : undefined;
          })(),
          sortOrder: (() => {
            const value = readStringParam(rawParams, "sortOrder");
            return value === "ASC" || value === "DESC" ? value : undefined;
          })(),
          pageSize: readNumberParam(rawParams, "pageSize", { integer: true }),
          page: readNumberParam(rawParams, "page", { integer: true }),
          search: readStringParam(rawParams, "search"),
          dateRangeColumn: readStringParam(rawParams, "dateRangeColumn"),
          startAt: readStringParam(rawParams, "startAt"),
          endAt: readStringParam(rawParams, "endAt"),
          timeoutSeconds: readNumberParam(rawParams, "timeoutSeconds", { integer: true }),
        }),
      ),
  };
}
