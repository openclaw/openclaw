import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { getJson, postForm, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import type { RecentTaskStore } from "../client/recent-tasks.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";

/** What we remember per user so report_status/report_stop can poll by slug. */
export interface RecentReport {
  slug: string;
  category: string;
  title: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  Pending: "处理中",
  Running: "生成中",
  Done: "已完成",
  Stop: "已停止",
};

function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

/** Categories a chat user may submit via save-requirement (DailyMonitoring is admin-only, omitted). */
const REQUIREMENT_CATEGORIES = [
  "Industry",
  "Event",
  "Evaluate",
  "Proofreading",
  "POFeed",
  "POWaterArmy",
  "Phenomenon",
  "SpecialReview",
] as const;

const CreateSchema = Type.Object(
  {
    category: Type.Optional(
      stringEnum(
        REQUIREMENT_CATEGORIES,
        "Report type. Industry=行业研报, Event=事件类报告, Evaluate=评估/应急处置, " +
          "Proofreading=事实核实/校对, POFeed=资讯流/复盘分析, POWaterArmy=水军分析, " +
          "Phenomenon=现象级课题, SpecialReview=专项审查. Default Event.",
      ),
    ),
    content: Type.Optional(
      Type.String({
        description:
          "需求描述/主题指令. Required for every category except Proofreading when `data` is supplied instead.",
      }),
    ),
    industry: Type.Optional(
      Type.String({ description: "目标行业/企业/课题/舆情主体名称, max 30 chars." }),
    ),
    dateRange: Type.Optional(
      Type.String({ description: "数据时间范围, e.g. '3d' (3 days), '7d', '1m'." }),
    ),
    keywords: Type.Optional(
      Type.Union([Type.Array(Type.String()), Type.String()], {
        description: "Keywords as an array or newline-separated string.",
      }),
    ),
    outline: Type.Optional(
      Type.String({ description: "Custom outline content. Providing it switches outlineType to Custom." }),
    ),
    data: Type.Optional(
      Type.String({ description: "参考数据文本; for Proofreading it can replace `content` as the text to verify." }),
    ),
    words: Type.Optional(Type.Number({ description: "Target word count. Optional." })),
    simple: Type.Optional(Type.Boolean({ description: "Generate a 简版 (short) report. Default false." })),
  },
  { additionalProperties: false },
);

const OpinionSchema = Type.Object(
  {
    category: stringEnum(
      ["Comment", "Respond"] as const,
      "Comment=生成评论/文章, Respond=生成官方回应/公关话术.",
    ),
    generateType: Type.Optional(
      stringEnum(
        ["Article", "Comment"] as const,
        "Required when category=Comment: Article=文章, Comment=短评(batch).",
      ),
    ),
    content: Type.String({ description: "完整的舆情监测简报内容或事件描述 (the briefing/event text)." }),
    data: Type.String({ description: "核心事实描述或立场引导语 (the stance/fact that constrains the tone)." }),
    instruction: Type.Optional(
      Type.String({ description: "AI 指令/角色设定. Required when category=Respond (回应稿目的)." }),
    ),
    target: Type.Optional(
      Type.String({ description: "发文单位/目标主体. Required when category=Respond." }),
    ),
    customInstruction: Type.Optional(
      Type.String({ description: "Custom instruction text, used when generating an Article with instruction=自定义." }),
    ),
    words: Type.Optional(
      Type.Number({
        description: "字数限制 or, for Comment mode, the number of comments (drives credit cost; defaults to 20).",
      }),
    ),
  },
  { additionalProperties: false },
);

const StatusSchema = Type.Object(
  {
    reportSlug: Type.Optional(
      Type.String({
        description: "Internal — leave unset. The tool polls the most recent report for this account on its own.",
      }),
    ),
  },
  { additionalProperties: false },
);

function normalizeKeywords(raw: unknown): string {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean).join("\n");
  }
  if (typeof raw === "string") {
    return raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join("\n");
  }
  return "";
}

/** Pull the just-created report's row out of fetch-list, matching by slug. */
async function findReportBySlug(
  config: BackendConfig,
  apiKey: string,
  category: string,
  slug: string,
): Promise<Record<string, unknown> | null> {
  const res = await getJson(
    config,
    "/industry-report/fetch-list",
    { category, page: 1, size: 50, siteId: config.siteId },
    apiKey,
  );
  const list = Array.isArray(res.list) ? (res.list as Record<string, unknown>[]) : [];
  return list.find((item) => asString(item.slug) === slug) ?? null;
}

export function createReportCreateToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentReport>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "report_create",
      label: "Create Report",
      description:
        "Submit a 行业研报/事件/评估/核实/舆情分析 report request (the same engine as the web 报告生成 page). " +
        "Generation runs asynchronously on the backend worker — call report_status (no arguments) to poll progress. " +
        "This consumes the account's report/舆情分析 quota. " +
        "The report is tracked server-side; never mention any internal id or slug to the user.",
      parameters: CreateSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "report_create");
        if ("error" in keyed) {
          return keyed.error;
        }
        const category = REQUIREMENT_CATEGORIES.includes(
          rawParams.category as (typeof REQUIREMENT_CATEGORIES)[number],
        )
          ? (rawParams.category as string)
          : "Event";
        const content = asString(rawParams.content);
        const data = asString(rawParams.data);
        if (category === "Proofreading") {
          if (!content && !data) {
            return jsonResult({
              success: false,
              error: "Proofreading needs either content or data (the text/link to verify).",
            });
          }
        } else if (!content) {
          return jsonResult({ success: false, error: "content is required (the request description)." });
        }
        const outline = asString(rawParams.outline);

        const fields: Record<string, string | number | undefined> = {
          category,
          content: content ?? "",
          industry: asString(rawParams.industry)?.slice(0, 30) ?? "",
          dateRange: asString(rawParams.dateRange) ?? "",
          keywords: normalizeKeywords(rawParams.keywords),
          outline: outline ?? "",
          outlineType: outline ? "Custom" : "AI",
          data: data ?? "",
          words: typeof rawParams.words === "number" ? rawParams.words : 0,
          simple: rawParams.simple ? 1 : 0,
          clientIp: "127.0.0.1",
          siteId: config.siteId,
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/industry-report/save-requirement", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "report_create", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const slug = asString(res.reportId);
        if (!slug) {
          return jsonResult({ success: false, error: "Backend did not return a report id." });
        }
        const title = content ? content.slice(0, 40) : null;
        store.remember(userId, { slug, category, title });
        return jsonResult({
          success: true,
          submitted: true,
          category,
          title,
          message: asString(res.message) ?? "任务提交成功",
          agentInstruction:
            "报告生成任务已提交成功。请立刻告知用户任务正在后台生成，通常需要数分钟。不要调用状态查询工具——等用户主动询问进度时再用 report_status 查询。",
        });
      },
    };
  };
}

export function createOpinionContentToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentReport>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "opinion_content_create",
      label: "Create Opinion Content",
      description:
        "Generate 评论/文章 (category=Comment) or 官方回应/公关话术 (category=Respond) from a 舆情简报. " +
        "Runs asynchronously — call report_status (no arguments) to poll the result. Consumes the account's quota " +
        "(Comment mode cost scales with `words`/条数, default 20). Tracked server-side; never mention any id to the user.",
      parameters: OpinionSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "opinion_content_create");
        if ("error" in keyed) {
          return keyed.error;
        }
        const category = rawParams.category === "Respond" ? "Respond" : "Comment";
        const content = asString(rawParams.content);
        const data = asString(rawParams.data);
        if (!content) {
          return jsonResult({ success: false, error: "content is required (the 舆情 briefing text)." });
        }
        if (!data) {
          return jsonResult({ success: false, error: "data is required (the stance/fact to constrain the tone)." });
        }
        const generateType = rawParams.generateType === "Article" ? "Article" : "Comment";
        const target = asString(rawParams.target);
        const instruction = asString(rawParams.instruction);
        if (category === "Respond" && (!target || !instruction)) {
          return jsonResult({
            success: false,
            error: 'category="Respond" requires both target (发文单位) and instruction (回应目的).',
          });
        }

        const fields: Record<string, string | number | undefined> = {
          category,
          generateType: category === "Comment" ? generateType : undefined,
          content,
          data,
          instruction: instruction ?? "",
          customInstruction: asString(rawParams.customInstruction) ?? "",
          target: target ?? "",
          words: typeof rawParams.words === "number" ? rawParams.words : undefined,
          clientIp: "127.0.0.1",
          siteId: config.siteId,
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/industry-report/save-public-opinion", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "opinion_content_create", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const slug = asString(res.reportId);
        if (!slug) {
          return jsonResult({ success: false, error: "Backend did not return a report id." });
        }
        const title = content.slice(0, 40);
        store.remember(userId, { slug, category, title });
        return jsonResult({
          success: true,
          submitted: true,
          category,
          mode: category === "Respond" ? "Respond" : generateType,
          title,
          message: asString(res.message) ?? "任务提交成功",
          agentInstruction:
            "内容生成任务已提交成功。请立刻告知用户任务正在后台生成，通常需要数分钟。不要调用状态查询工具——等用户主动询问进度时再用 report_status 查询。",
        });
      },
    };
  };
}

export function createReportStatusToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentReport>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "report_status",
      label: "Report Status",
      description:
        "Get the status of the most recent report created with report_create or opinion_content_create. " +
        "Call with no arguments. " +
        "⚠️ SINGLE-USE PER TURN: call EXACTLY ONCE per user request, then immediately reply to the user — " +
        "regardless of whether the report is done. NEVER call this tool a second time in the same turn.",
      parameters: StatusSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "report_status");
        if ("error" in keyed) {
          return keyed.error;
        }
        const recent = store.latest(userId);
        const slug = asString(rawParams.reportSlug) ?? recent?.slug;
        const category = recent?.category ?? "";
        if (!slug) {
          return jsonResult({
            success: false,
            error: "No recent report to poll; create one with report_create first.",
          });
        }

        let row: Record<string, unknown> | null;
        try {
          row = await findReportBySlug(config, keyed.apiKey, category, slug);
        } catch (error) {
          return failure(api, "report_status", userId, error);
        }
        if (!row) {
          return jsonResult({
            success: true,
            found: false,
            agentInstruction:
              "⚠️ 报告已提交但尚未出现在列表中，属正常现象。请立刻告知用户「任务正在队列中处理，稍后可再询问进度」，然后结束本轮对话。禁止再次调用此工具。",
          });
        }
        const status = asString(row.status) ?? "";
        const done = status === "Done";
        const stopped = status === "Stop";
        const terminal = done || stopped;
        return jsonResult({
          success: true,
          found: true,
          status,
          statusLabel: STATUS_LABELS[status] ?? status ?? "未知",
          ...(terminal ? { done, stopped } : {}),
          runningError: Boolean(row.runningError),
          title: asString(row.title) ?? recent?.title ?? null,
          category: asString(row.category) ?? category,
          date: asString(row.date) ?? null,
          agentInstruction: terminal
            ? "报告已结束，请向用户展示结果。"
            : "⚠️ 报告仍在生成中。请立刻向用户报告当前进度并结束本轮对话。禁止再次调用此工具或任何其他工具。",
        });
      },
    };
  };
}

export function createReportStopToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentReport>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "report_stop",
      label: "Stop Report",
      description:
        "Stop the most recent in-progress report created with report_create/opinion_content_create. " +
        "Call it with no arguments — it targets the latest report for this account.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_toolCallId: string) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "report_stop");
        if ("error" in keyed) {
          return keyed.error;
        }
        const recent = store.latest(userId);
        if (!recent) {
          return jsonResult({
            success: false,
            error: "No recent report to stop; create one with report_create first.",
          });
        }

        let row: Record<string, unknown> | null;
        try {
          row = await findReportBySlug(config, keyed.apiKey, recent.category, recent.slug);
        } catch (error) {
          return failure(api, "report_stop", userId, error);
        }
        const reportId = Number(row?.id);
        if (!Number.isInteger(reportId) || reportId <= 0) {
          return jsonResult({
            success: false,
            error: "Could not locate the report to stop (it may already be finished).",
          });
        }

        let res: Record<string, unknown>;
        try {
          res = await getJson(config, "/industry-report/stop-report", { id: reportId }, keyed.apiKey);
        } catch (error) {
          return failure(api, "report_stop", userId, error);
        }
        if (res.code !== "success") {
          return jsonResult({
            success: false,
            error: asString(res.message) ?? "Backend rejected the stop request.",
          });
        }
        return jsonResult({ success: true, title: recent.title });
      },
    };
  };
}
