import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, getJson, postForm, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import type { RecentTaskStore } from "../client/recent-tasks.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";

/** What we remember per user so opinion_download_status can poll a submitted task by slug. */
export interface RecentDownload {
  slug: string;
  category: string;
  title: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  Pending: "处理中",
  Done: "已完成",
  Fail: "失败",
  Stop: "已停止",
};

function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

// 速报 (Flash) is intentionally not a backend tool — the agent writes flash briefings directly in chat.
const ANALYZE_CATEGORIES = ["RiskEvaluation", "Disposal", "DailyRiskTips"] as const;
const EXPORT_CATEGORIES = ["Report", "Feed", "AllFeed"] as const;

const AnalyzeSchema = Type.Object(
  {
    data: Type.String({
      description:
        "The 舆情 content to analyze: news text, a paragraph, or text containing http(s) links " +
        "(the backend auto-crawls up to 3 links). ",
    }),
    category: Type.Optional(
      stringEnum(
        ANALYZE_CATEGORIES,
        "RiskEvaluation=风险研判(default), Disposal=舆情处置快报, DailyRiskTips=每日风险提示.",
      ),
    ),
    title: Type.Optional(Type.String({ description: "Optional title; auto-derived from data if omitted." })),
    requirement: Type.Optional(Type.String({ description: "Custom analysis instruction, e.g. '主要做风险研判'." })),
    cluster: Type.Optional(Type.Boolean({ description: "Enable cluster analysis (聚类). Default false." })),
  },
  { additionalProperties: false },
);

const ExportSchema = Type.Object(
  {
    reportId: Type.Number({ description: "智脑项目 ID (must be a DailyMonitoring project). Required." }),
    category: Type.Optional(
      stringEnum(
        EXPORT_CATEGORIES,
        "Report=智脑分析报告(日/周/月)(default), Feed=智脑数据下载, AllFeed=原始数据下载.",
      ),
    ),
    dateType: Type.Optional(
      stringEnum(
        ["date", "week", "month", "datetimerange"] as const,
        "For category=Report: date=日报, week=周报, month=月报, datetimerange=自定义.",
      ),
    ),
    dateScope: Type.Optional(
      Type.String({
        description:
          "For category=Report: the period. date='YYYY-MM-DD', month='YYYY-MM', week='YYYY-N周'. " +
          "For datetimerange pass 'start,end'.",
      }),
    ),
    topicId: Type.Optional(Type.Number({ description: "监测方案 ID (optional)." })),
  },
  { additionalProperties: false },
);

const SheetSchema = Type.Object(
  {
    fileLink: Type.String({
      description:
        "Public URL to an .xlsx/.csv of 舆情 data. The filename must carry a 14-char prefix " +
        "(e.g. a YYYYMMDDHHmmss timestamp) — the title is taken from char 15 onward.",
    }),
    requirement: Type.Optional(Type.String({ description: "Analysis requirement, e.g. '写一篇分析报告'." })),
  },
  { additionalProperties: false },
);

const StatusSchema = Type.Object(
  {
    slug: Type.Optional(
      Type.String({
        description: "Internal — leave unset. Polls the most recent submitted 舆情 task for this account.",
      }),
    ),
  },
  { additionalProperties: false },
);

const ListSchema = Type.Object(
  {
    category: Type.Optional(
      Type.String({ description: "Filter by category (comma-separated for several) or 'All'. Default All." }),
    ),
    page: Type.Optional(Type.Number({ description: "Page number. Default 1." })),
    size: Type.Optional(Type.Number({ description: "Page size 10-100. Default 20." })),
  },
  { additionalProperties: false },
);

/** Find a submitted task row in fetch-downloads, matching by slug. */
async function findDownloadBySlug(
  config: BackendConfig,
  apiKey: string,
  category: string,
  slug: string,
): Promise<Record<string, unknown> | null> {
  const res = await getJson(
    config,
    "/pub-opinion/fetch-downloads",
    { category: category || "All", page: 1, size: 50 },
    apiKey,
  );
  const items = Array.isArray(res.items) ? (res.items as Record<string, unknown>[]) : [];
  return items.find((item) => asString(item.slug) === slug) ?? null;
}

export function createOpinionAnalyzeToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentDownload>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "opinion_analyze",
      label: "Analyze Opinion / 舆情简报",
      description:
        "Submit text or links for instant 舆情分析/简报 (风险研判/处置快报/风险提示). " +
        "Runs asynchronously on the backend worker — call opinion_download_status (no arguments) to poll. " +
        "The analysis text comes back in the status result's content/title. Tracked server-side; never mention any id to the user.",
      parameters: AnalyzeSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "opinion_analyze");
        if ("error" in keyed) {
          return keyed.error;
        }
        const data = asString(rawParams.data);
        if (!data) {
          return jsonResult({ success: false, error: "data is required (the text or links to analyze)." });
        }
        const category = ANALYZE_CATEGORIES.includes(
          rawParams.category as (typeof ANALYZE_CATEGORIES)[number],
        )
          ? (rawParams.category as string)
          : "RiskEvaluation";
        const fields: Record<string, FieldValue> = {
          category,
          data,
          title: asString(rawParams.title),
          requirement: asString(rawParams.requirement),
          cluster: rawParams.cluster ? 1 : 0,
          siteId: config.siteId,
          ip: "127.0.0.1",
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/pub-opinion/request-download", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "opinion_analyze", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const slug = asString(res.slug);
        if (!slug) {
          return jsonResult({ success: false, error: "Backend did not return a task id." });
        }
        const title = asString(rawParams.title) ?? data.replace(/https?:\/\/\S+/g, "").slice(0, 40);
        store.remember(userId, { slug, category, title });
        return jsonResult({
          success: true,
          submitted: true,
          category,
          title,
          message: asString(res.message) ?? "任务已提交",
          agentInstruction:
            "舆情分析任务已提交成功。请立刻告知用户任务正在后台处理，通常需要数分钟。不要调用状态查询工具——等用户主动询问进度时再用 opinion_download_status 查询。",
        });
      },
    };
  };
}

export function createOpinionExportToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentDownload>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "opinion_report_export",
      label: "Export 智脑 Report / Data",
      description:
        "Export a 智脑项目 report (日/周/月报) or its 舆情数据 to a file. Requires the project's reportId. " +
        "Runs asynchronously — call opinion_download_status (no arguments) to poll, then read fileLink when Done. " +
        "Tracked server-side; never mention any id to the user.",
      parameters: ExportSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "opinion_report_export");
        if ("error" in keyed) {
          return keyed.error;
        }
        const reportId = Number(rawParams.reportId);
        if (!Number.isInteger(reportId) || reportId <= 0) {
          return jsonResult({ success: false, error: "reportId is required (the 智脑项目 id)." });
        }
        const category = EXPORT_CATEGORIES.includes(
          rawParams.category as (typeof EXPORT_CATEGORIES)[number],
        )
          ? (rawParams.category as string)
          : "Report";
        const dateType = asString(rawParams.dateType);
        const dateScopeRaw = asString(rawParams.dateScope);
        // datetimerange takes an array; other dateTypes take a scalar scope.
        const dateScope: FieldValue =
          dateType === "datetimerange" && dateScopeRaw
            ? dateScopeRaw.split(",").map((s) => s.trim()).filter(Boolean)
            : dateScopeRaw;

        const fields: Record<string, FieldValue> = {
          category,
          reportId,
          topicId: Number.isInteger(Number(rawParams.topicId)) ? Number(rawParams.topicId) : undefined,
          dateType: category === "Report" ? dateType : undefined,
          dateScope: category === "Report" ? dateScope : undefined,
          siteId: config.siteId,
          ip: "127.0.0.1",
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/pub-opinion/request-download", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "opinion_report_export", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const slug = asString(res.slug);
        if (!slug) {
          return jsonResult({ success: false, error: "Backend did not return a task id." });
        }
        store.remember(userId, { slug, category, title: null });
        return jsonResult({
          success: true,
          submitted: true,
          category,
          message: asString(res.message) ?? "任务已提交",
          agentInstruction:
            "报告导出任务已提交成功。请立刻告知用户任务正在后台处理。不要调用状态查询工具——等用户主动询问进度时再用 opinion_download_status 查询。",
        });
      },
    };
  };
}

export function createSheetReportToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentDownload>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "sheet_report_create",
      label: "Create 精品报告 from Sheet",
      description:
        "Submit an .xlsx/.csv of 舆情 data (by public URL) for 精品报告 generation. " +
        "Runs asynchronously — call opinion_download_status (no arguments) to poll, then read fileLink when Done. " +
        "Tracked server-side; never mention any id to the user.",
      parameters: SheetSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "sheet_report_create");
        if ("error" in keyed) {
          return keyed.error;
        }
        const fileLink = asString(rawParams.fileLink);
        if (!fileLink) {
          return jsonResult({ success: false, error: "fileLink is required (a public .xlsx/.csv URL)." });
        }
        const fields: Record<string, FieldValue> = {
          fileLink,
          requirement: asString(rawParams.requirement) ?? "",
          siteId: config.siteId,
          ip: "127.0.0.1",
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/pub-opinion/submit-sheet-report-job", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "sheet_report_create", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const slug = asString(res.slug);
        if (!slug) {
          return jsonResult({ success: false, error: "Backend did not return a task id." });
        }
        store.remember(userId, { slug, category: "SheetReport", title: null });
        return jsonResult({
          success: true,
          submitted: true,
          message: asString(res.message) ?? "任务已提交",
          agentInstruction:
            "精品报告生成任务已提交成功。请立刻告知用户任务正在后台处理。不要调用状态查询工具——等用户主动询问进度时再用 opinion_download_status 查询。",
        });
      },
    };
  };
}

export function createOpinionDownloadStatusToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentDownload>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "opinion_download_status",
      label: "舆情 Task Status",
      description:
        "Get the status/result of the most recent 舆情 task. Call with no arguments. " +
        "⚠️ SINGLE-USE PER TURN: call EXACTLY ONCE per user request, then immediately reply to the user — " +
        "regardless of whether the task is done. NEVER call this tool a second time in the same turn.",
      parameters: StatusSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "opinion_download_status");
        if ("error" in keyed) {
          return keyed.error;
        }
        const recent = store.latest(userId);
        const slug = asString(rawParams.slug) ?? recent?.slug;
        const category = recent?.category ?? "All";
        if (!slug) {
          return jsonResult({
            success: false,
            error: "No recent 舆情 task to poll; submit one first (opinion_analyze / opinion_report_export / sheet_report_create).",
          });
        }

        let row: Record<string, unknown> | null;
        try {
          row = await findDownloadBySlug(config, keyed.apiKey, category, slug);
        } catch (error) {
          return failure(api, "opinion_download_status", userId, error);
        }
        if (!row) {
          return jsonResult({
            success: true,
            found: false,
            agentInstruction:
              "⚠️ 任务已提交但尚未出现在列表中，属正常现象。请立刻告知用户「任务正在队列中处理，稍后可再询问进度」，然后结束本轮对话。禁止再次调用此工具。",
          });
        }
        const status = asString(row.status) ?? "";
        const fileLink = asString(row.fileLink);
        const done = status === "Done";
        const failed = status === "Fail";
        const stopped = status === "Stop";
        const terminal = done || failed || stopped;
        return jsonResult({
          success: true,
          found: true,
          status,
          statusLabel: STATUS_LABELS[status] ?? status ?? "未知",
          ...(terminal ? { done, failed, stopped } : {}),
          title: asString(row.title) ?? recent?.title ?? null,
          fileLink: fileLink ?? null,
          content: asString(row.content) ?? null,
          memo: asString(row.memo) ?? null,
          agentInstruction: terminal
            ? "任务已结束，请向用户展示结果。"
            : "⚠️ 任务仍在处理中。请立刻向用户报告当前进度并结束本轮对话。禁止再次调用此工具或任何其他工具。",
        });
      },
    };
  };
}

export function createOpinionDownloadListToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "opinion_download_list",
      label: "List 舆情 Tasks",
      description:
        "List this account's 舆情 download/report tasks (most recent first), optionally filtered by category. " +
        "Use it when the user asks what reports/exports exist.",
      parameters: ListSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "opinion_download_list");
        if ("error" in keyed) {
          return keyed.error;
        }
        const page = Math.max(1, Number(rawParams.page ?? 1) || 1);
        const size = Math.min(100, Math.max(10, Number(rawParams.size ?? 20) || 20));
        const category = asString(rawParams.category) ?? "All";

        let res: Record<string, unknown>;
        try {
          res = await getJson(config, "/pub-opinion/fetch-downloads", { category, page, size }, keyed.apiKey);
        } catch (error) {
          return failure(api, "opinion_download_list", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const items = Array.isArray(res.items) ? (res.items as Record<string, unknown>[]) : [];
        const list = items.map((item) => {
          const status = asString(item.status) ?? "";
          return {
            category: asString(item.category) ?? null,
            status,
            statusLabel: STATUS_LABELS[status] ?? status,
            title: asString(item.title) ?? null,
            fileLink: asString(item.fileLink) ?? null,
            date: asString(item.date) ?? null,
          };
        });
        return jsonResult({ success: true, total: Number(res.total ?? list.length), list });
      },
    };
  };
}
