import { Type } from "@sinclair/typebox";
import type { RowDataPacket } from "mysql2/promise";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { AuthTopicResolver, type AuthorizedTopic } from "./auth-topic-resolver.js";
import {
  buildSearchQuery,
  buildStatsQueries,
  UnauthorizedTopicError,
  type FeedQueryFilters,
} from "./feed-query-builder.js";
import { AGGREGATION_DIMENSIONS, EMOTIONS, LEVELS, SEARCH_LIMIT_MAX } from "./feed-query-fields.js";
import { executeQuery, resolveConfig } from "./mysql-client.js";

/**
 * Chat agents spawned by the rabbitmq-consumer pipeline are named
 * `rabbitmq-<userId>` (see extensions/rabbitmq-consumer/src/chat-pipeline.ts).
 * The captured userId is the trusted identity for topic authorization —
 * never accept a userId from tool parameters.
 */
const RABBITMQ_AGENT_PATTERN = /^rabbitmq-(.+)$/;

function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

const FeedQueryToolSchema = Type.Object(
  {
    mode: Type.Optional(
      stringEnum(
        ["search", "stats"] as const,
        '"search" (default) returns matching items; "stats" returns aggregate counts over the full filtered set.',
      ),
    ),
    topicId: Type.Optional(
      Type.Number({
        description:
          "Monitoring topic (project) id to query. Omit to use your primary topic. " +
          "Must be one of the topics you are authorized for (see the [topicId:...] message prefix).",
      }),
    ),
    startDate: Type.Optional(
      Type.String({ description: "Inclusive start date, YYYY-MM-DD (Asia/Shanghai)." }),
    ),
    endDate: Type.Optional(
      Type.String({ description: "Inclusive end date, YYYY-MM-DD (Asia/Shanghai)." }),
    ),
    level: Type.Optional(
      Type.Array(stringEnum(LEVELS, "Risk level."), {
        description: "Filter by risk level(s): Red (highest) to Blue (lowest).",
      }),
    ),
    emotion: Type.Optional(
      Type.Array(stringEnum(EMOTIONS, "Sentiment."), {
        description: "Filter by sentiment value(s).",
      }),
    ),
    platform: Type.Optional(
      Type.String({ description: "Exact platform name filter (e.g. 微博, 微信, 抖音)." }),
    ),
    keyword: Type.Optional(
      Type.String({ description: "Substring matched against title, summary, and content." }),
    ),
    groupBy: Type.Optional(
      Type.Array(
        stringEnum(
          Object.keys(AGGREGATION_DIMENSIONS) as unknown as readonly string[],
          "Aggregation dimension.",
        ),
        { description: "Stats mode only: dimensions to group counts by." },
      ),
    ),
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: SEARCH_LIMIT_MAX,
        description: `Search mode only: max items to return (default 20, max ${SEARCH_LIMIT_MAX}).`,
      }),
    ),
  },
  { additionalProperties: false },
);

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((v): v is string => typeof v === "string");
  return strings.length > 0 ? strings : undefined;
}

function readOptionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function parseFilters(rawParams: Record<string, unknown>): FeedQueryFilters {
  return {
    topicId: readOptionalInt(rawParams.topicId),
    startDate: readOptionalString(rawParams.startDate),
    endDate: readOptionalString(rawParams.endDate),
    level: readStringArray(rawParams.level),
    emotion: readStringArray(rawParams.emotion),
    platform: readOptionalString(rawParams.platform),
    keyword: readOptionalString(rawParams.keyword),
    groupBy: readStringArray(rawParams.groupBy),
    limit: readOptionalInt(rawParams.limit),
  };
}

function topicSummary(
  topics: AuthorizedTopic[],
): Array<{ topicId: number; topicName: string | null }> {
  // Sorted by topicId so the LLM-visible list is deterministic regardless of
  // entity_auth row order (prompt-cache friendly).
  return topics
    .map((t) => ({ topicId: t.topicId, topicName: t.topicName }))
    .toSorted((a, b) => a.topicId - b.topicId);
}

/**
 * Create the feed_query tool factory. The factory only exposes the tool to
 * `rabbitmq-<userId>` agents; every execution re-resolves the user's
 * authorized topics server-side and queries through parameterized,
 * whitelist-projected SQL.
 */
export function createFeedQueryToolFactory(api: OpenClawPluginApi) {
  const config = resolveConfig(api.pluginConfig ?? {});
  const resolver = new AuthTopicResolver(config);

  return (ctx: { agentId?: string }) => {
    const match = RABBITMQ_AGENT_PATTERN.exec(ctx.agentId ?? "");
    const userId = match?.[1];
    if (!userId) {
      return null;
    }

    return {
      name: "feed_query",
      label: "Feed Query",
      description:
        "Query the sentiment-monitoring (舆情) database for your authorized monitoring topics. " +
        'Use mode="search" for recent matching items (title, summary, platform, risk level, ' +
        'sentiment, link) and mode="stats" for aggregate counts over the full filtered set. ' +
        "Access is automatically restricted to topics owned by the current user.",
      parameters: FeedQueryToolSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const mode = rawParams.mode === "stats" ? "stats" : "search";
        const filters = parseFilters(rawParams);

        let topics: AuthorizedTopic[];
        try {
          topics = await resolver.getAuthorizedTopics(userId);
        } catch (error) {
          api.logger.error(`[FEED_QUERY] topic resolution failed for ${userId}: ${String(error)}`);
          return jsonResult({
            success: false,
            error: "Failed to resolve your authorized topics; try again later.",
          });
        }
        if (topics.length === 0) {
          return jsonResult({
            success: false,
            error: "No authorized monitoring topics for this account.",
          });
        }

        try {
          if (mode === "stats") {
            return jsonResult(await runStats(config, filters, topics));
          }
          return jsonResult(await runSearch(config, filters, topics));
        } catch (error) {
          if (error instanceof UnauthorizedTopicError) {
            return jsonResult({
              success: false,
              error: error.message,
              authorizedTopics: topicSummary(error.authorizedTopics),
            });
          }
          if (
            error instanceof RangeError ||
            (error instanceof Error && /YYYY-MM-DD/.test(error.message))
          ) {
            // Parameter validation errors only echo the caller's own input.
            return jsonResult({ success: false, error: error.message });
          }
          api.logger.error(`[FEED_QUERY] query failed for user ${userId}: ${String(error)}`);
          return jsonResult({
            success: false,
            error: "Query execution failed; see gateway logs for details.",
          });
        }
      },
    };
  };
}

type DbConfig = ReturnType<typeof resolveConfig>;

async function runSearch(config: DbConfig, filters: FeedQueryFilters, topics: AuthorizedTopic[]) {
  const { sql, values, topic } = buildSearchQuery(filters, topics);
  const rows = await executeQuery<RowDataPacket[]>(config, sql, values);
  const items: Array<Record<string, unknown>> = rows ?? [];
  return {
    success: true,
    topic: { topicId: topic.topicId, topicName: topic.topicName },
    count: items.length,
    items,
  };
}

async function runStats(config: DbConfig, filters: FeedQueryFilters, topics: AuthorizedTopic[]) {
  const { topic, totalQuery, dimensionQueries } = buildStatsQueries(filters, topics);
  const totalRows = await executeQuery<RowDataPacket[]>(config, totalQuery.sql, totalQuery.values);
  const total = Number(totalRows?.[0]?.cnt) || 0;

  const aggregations: Array<{
    dimension: string;
    buckets: Array<{ value: string; count: number }>;
  }> = [];
  for (const query of dimensionQueries) {
    const rows = await executeQuery<RowDataPacket[]>(config, query.sql, query.values);
    aggregations.push({
      dimension: query.dimension,
      buckets: (rows ?? []).map((row) => ({
        value: row.value === null || row.value === undefined ? "(none)" : String(row.value),
        count: Number(row.cnt) || 0,
      })),
    });
  }

  return {
    success: true,
    topic: { topicId: topic.topicId, topicName: topic.topicName },
    total,
    aggregations,
  };
}
