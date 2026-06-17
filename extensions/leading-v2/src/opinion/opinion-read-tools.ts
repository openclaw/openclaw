import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, getJson, postForm, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";

function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

const PLATFORMS = [
  "douyin",
  "weibo",
  "weixin",
  "toutiao",
  "xiaohongshu",
  "web",
  "app",
  "bbs",
  "enews",
  "jingwai",
  "shipin",
] as const;
const RISK_LEVELS = ["Red", "Orange", "Yellow", "Blue"] as const;
const EMOTIONS = ["Positive", "Neutral", "Negative"] as const;

const FeedListSchema = Type.Object(
  {
    topicId: Type.Number({ description: "主监测方案 ID (required). Get it from topic_list." }),
    slaveTopicId: Type.Optional(Type.Number({ description: "子监测方案 ID (optional)." })),
    q: Type.Optional(Type.String({ description: "Full-text keyword over title/author/summary/content." })),
    page: Type.Optional(Type.Number({ description: "Page number. Default 1." })),
    size: Type.Optional(Type.Number({ description: "Page size. Default 20." })),
    from: Type.Optional(Type.Number({ description: "Start time, UNIX seconds." })),
    to: Type.Optional(Type.Number({ description: "End time, UNIX seconds." })),
    platforms: Type.Optional(Type.Array(stringEnum(PLATFORMS, "Platform filter."), { description: "Platform filter." })),
    riskLevels: Type.Optional(
      Type.Array(stringEnum(RISK_LEVELS, "Risk level."), {
        description: "Risk filter: Red=重大, Orange=较大, Yellow=一般, Blue=小微.",
      }),
    ),
    emotions: Type.Optional(
      Type.Array(stringEnum(EMOTIONS, "Emotion."), { description: "Emotion: Positive/Neutral/Negative." }),
    ),
    offlineOnly: Type.Optional(Type.Boolean({ description: "Only 失效 (offline) items. Default false." })),
  },
  { additionalProperties: false },
);

const TopicListSchema = Type.Object(
  {
    reportId: Type.Union([Type.Number(), Type.String()], {
      description: "智脑项目 id or slug (required).",
    }),
    active: Type.Optional(Type.Boolean({ description: "Only schemes with analysis enabled. Default false." })),
  },
  { additionalProperties: false },
);

const ReanalyzeSchema = Type.Object(
  {
    topicId: Type.Number({ description: "主监测方案 ID (>0, required)." }),
    reportId: Type.Number({ description: "智脑项目 ID (>0, required)." }),
    ids: Type.Array(Type.Number(), { description: "Feed item ids to re-analyze (non-empty)." }),
    ruleTypes: Type.Array(
      stringEnum(["Categorize", "PreCheck", "DoubleCheck"] as const, "Rule type."),
      {
        description:
          "Which analyses to re-run: Categorize=分流(multi-scheme only), PreCheck=数据过滤, DoubleCheck=数据标签. At least one.",
      },
    ),
    mode: Type.Optional(
      stringEnum(["active", "test"] as const, "Rule variant applied to each ruleType: active(default) or test."),
    ),
  },
  { additionalProperties: false },
);

const MonthlySchema = Type.Object(
  {
    clusterId: Type.Number({ description: "聚类/集群 ID (required)." }),
    months: Type.Array(Type.String(), { description: "Months as YYYYMM, e.g. ['202510','202511']." }),
    label: Type.Optional(Type.Boolean({ description: "Query the event-cluster table (flag=label). Default false." })),
  },
  { additionalProperties: false },
);

export function createFeedListToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "feed_list",
      label: "List 舆情 Feeds",
      description:
        "Read the 舆情 monitoring items for a 监测方案 (topicId), with optional keyword/time/platform/risk/emotion filters. " +
        "Returns each item's title, platform, emotion, risk level, AI summary and link. Read-only.",
      parameters: FeedListSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "feed_list");
        if ("error" in keyed) {
          return keyed.error;
        }
        const topicId = Number(rawParams.topicId);
        if (!Number.isInteger(topicId) || topicId <= 0) {
          return jsonResult({ success: false, error: "topicId is required (from topic_list)." });
        }
        const params: Record<string, FieldValue> = {
          topicId,
          slaveTopicId: Number.isInteger(Number(rawParams.slaveTopicId))
            ? Number(rawParams.slaveTopicId)
            : undefined,
          q: asString(rawParams.q),
          page: Math.max(1, Number(rawParams.page ?? 1) || 1),
          size: Math.min(100, Math.max(1, Number(rawParams.size ?? 20) || 20)),
          from: Number.isInteger(Number(rawParams.from)) ? Number(rawParams.from) : undefined,
          to: Number.isInteger(Number(rawParams.to)) ? Number(rawParams.to) : undefined,
          platforms: Array.isArray(rawParams.platforms) ? (rawParams.platforms as string[]) : undefined,
          riskLevels: Array.isArray(rawParams.riskLevels) ? (rawParams.riskLevels as string[]) : undefined,
          emotions: Array.isArray(rawParams.emotions) ? (rawParams.emotions as string[]) : undefined,
          offlineOnly: rawParams.offlineOnly ? 1 : undefined,
        };

        let res: Record<string, unknown>;
        try {
          res = await getJson(config, "/pub-opinion/fetch-feeds", params, keyed.apiKey);
        } catch (error) {
          return failure(api, "feed_list", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const rows = Array.isArray(res.list) ? (res.list as Record<string, unknown>[]) : [];
        const list = rows.map((item) => ({
          id: Number(item.id),
          title: asString(item.title) ?? null,
          platform: asString(item.platform) ?? null,
          emotion: asString(item.emotion) ?? null,
          level: asString(item.level) ?? null,
          summary: asString(item.summary) ?? null,
          link: asString(item.link) ?? null,
          date: asString(item.date) ?? null,
        }));
        return jsonResult({ success: true, total: Number(res.total ?? list.length), list });
      },
    };
  };
}

export function createTopicListToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "topic_list",
      label: "List 监测方案",
      description:
        "List the 监测方案 (monitoring schemes) of a 智脑项目 (by reportId or slug). " +
        "Returns each scheme's id, title, whether it is the master scheme, and whether analysis is enabled. " +
        "Use it to discover the topicId needed by feed_list / feed_reanalyze. Read-only.",
      parameters: TopicListSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "topic_list");
        if ("error" in keyed) {
          return keyed.error;
        }
        const rawReportId = rawParams.reportId;
        const reportId =
          typeof rawReportId === "string" && rawReportId.trim()
            ? rawReportId.trim()
            : typeof rawReportId === "number"
              ? String(rawReportId)
              : undefined;
        if (!reportId) {
          return jsonResult({ success: false, error: "reportId is required (智脑项目 id or slug)." });
        }
        const params: Record<string, FieldValue> = {
          reportId,
          siteId: config.siteId,
          active: rawParams.active ? 1 : undefined,
        };

        let res: Record<string, unknown>;
        try {
          res = await getJson(config, "/pub-opinion/fetch-topics-by-project", params, keyed.apiKey);
        } catch (error) {
          return failure(api, "topic_list", userId, error);
        }
        if (res.dos === 1) {
          return jsonResult({ success: false, error: "Not authorized to view this project's schemes." });
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const rows = Array.isArray(res.list) ? (res.list as Record<string, unknown>[]) : [];
        const list = rows.map((item) => ({
          topicId: Number(item.id),
          refId: Number(item.refId ?? 0),
          title: asString(item.title) ?? null,
          master: Number(item.master) === 1,
          enableAnalysis: Number(item.enableAnalysis) === 1,
        }));
        return jsonResult({ success: true, list });
      },
    };
  };
}

export function createFeedReanalyzeToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "feed_reanalyze",
      label: "Re-analyze 舆情 Items",
      description:
        "Re-run AI analysis (分流/预检/双检) on specific 舆情 items. Requires the updateFeed permission. " +
        "Runs asynchronously — poll feed_list to watch the items leave PENDING. Each item consumes analysis budget.",
      parameters: ReanalyzeSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "feed_reanalyze");
        if ("error" in keyed) {
          return keyed.error;
        }
        const topicId = Number(rawParams.topicId);
        const reportId = Number(rawParams.reportId);
        const ids = Array.isArray(rawParams.ids)
          ? (rawParams.ids as unknown[]).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
          : [];
        const ruleTypes = Array.isArray(rawParams.ruleTypes) ? (rawParams.ruleTypes as string[]) : [];
        if (!Number.isInteger(topicId) || topicId <= 0) {
          return jsonResult({ success: false, error: "topicId must be > 0." });
        }
        if (!Number.isInteger(reportId) || reportId <= 0) {
          return jsonResult({ success: false, error: "reportId must be > 0." });
        }
        if (ids.length === 0) {
          return jsonResult({ success: false, error: "ids must be a non-empty list of item ids." });
        }
        if (ruleTypes.length === 0) {
          return jsonResult({ success: false, error: "ruleTypes must include at least one of Categorize/PreCheck/DoubleCheck." });
        }
        const mode = rawParams.mode === "test" ? "test" : "active";
        const fields: Record<string, FieldValue> = {
          topicId,
          reportId,
          ids,
          ruleTypes,
          // Backend reads lcfirst(ruleType) keys; provide the variant for each selected rule.
          categorize: ruleTypes.includes("Categorize") ? mode : undefined,
          preCheck: ruleTypes.includes("PreCheck") ? mode : undefined,
          doubleCheck: ruleTypes.includes("DoubleCheck") ? mode : undefined,
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/pub-opinion/reanalyze-items", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "feed_reanalyze", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        if (res.code !== "success" && res.code !== "0" && res.code !== 0) {
          return jsonResult({ success: false, error: asString(res.message) ?? "Backend rejected the request." });
        }
        return jsonResult({
          success: true,
          submitted: ids.length,
          ruleTypes,
          message: asString(res.message) ?? `数据已提交重新分析，请等待：${ids.length}条`,
        });
      },
    };
  };
}

export function createMonthlyStatsToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "monthly_stats",
      label: "Monthly 舆情 Stats",
      description:
        "Get per-day 舆情 statistics (total + negative counts) for a cluster over one or more months. " +
        "Returns 31 rows per month (missing days are zero). Read-only/synchronous.",
      parameters: MonthlySchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "monthly_stats");
        if ("error" in keyed) {
          return keyed.error;
        }
        const clusterId = Number(rawParams.clusterId);
        const months = Array.isArray(rawParams.months)
          ? (rawParams.months as unknown[]).map((m) => String(m).trim()).filter((m) => /^\d{6}$/.test(m))
          : [];
        if (!Number.isInteger(clusterId) || clusterId <= 0) {
          return jsonResult({ success: false, error: "clusterId is required (> 0)." });
        }
        if (months.length === 0) {
          return jsonResult({ success: false, error: "months must be a non-empty list of YYYYMM strings." });
        }
        const fields: Record<string, FieldValue> = {
          clusterId,
          date: months,
          flag: rawParams.label ? "label" : undefined,
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/pub-opinion/request-monthly-date", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "monthly_stats", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const data = Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];
        // Keep payload compact: drop the per-day negative article-id arrays.
        const days = data.map((d) => {
          const { articles: _articles, ...rest } = d;
          return rest;
        });
        return jsonResult({ success: true, days });
      },
    };
  };
}
