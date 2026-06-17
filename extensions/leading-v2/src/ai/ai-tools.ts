import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, getJson, postForm, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";

const DEFAULT_WORKSPACE = "pr";

const JOB_STATUS_LABELS: Record<string, string> = {
  Pending: "处理中",
  Done: "已完成",
  Stop: "已停止",
};

const LETTER_LABELS: Record<string, string> = {
  Retraction: "撤稿函",
  Report: "举报信",
  Complaint: "投诉信",
  GovOfficial: "官方公函",
  GovPersonal: "个人公函",
};

const ListSchema = Type.Object(
  {
    q: Type.Optional(Type.String({ description: "Keyword over the task label." })),
    page: Type.Optional(Type.Number({ description: "Page number. Default 1." })),
    size: Type.Optional(Type.Number({ description: "Page size. Default 10." })),
  },
  { additionalProperties: false },
);

const LetterGenerateSchema = Type.Object(
  {
    errors: Type.String({
      description:
        "违规内容详细描述 (the specific false facts + cited laws), at least 20 chars. " +
        "Targets the most recent 内容检测 task for this account.",
    }),
    all: Type.Optional(
      Type.Boolean({
        description: "Generate every letter type (撤稿函/举报信/投诉信/官方公函/个人公函). Default lets the backend choose by task type.",
      }),
    ),
  },
  { additionalProperties: false },
);

const EmptySchema = Type.Object({}, { additionalProperties: false });

/** Resolve the most recent pr-workspace job id for this account (the one just created in chat). */
async function resolveLatestJobId(config: BackendConfig, apiKey: string): Promise<number | null> {
  const res = await getJson(
    config,
    "/ai/fetch-jobs",
    { workspace: DEFAULT_WORKSPACE, page: 1, size: 1 },
    apiKey,
  );
  const jobs = Array.isArray(res.jobs) ? (res.jobs as Record<string, unknown>[]) : [];
  const id = Number(jobs[0]?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function createJobListToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "job_list",
      label: "List 检测 Tasks",
      description:
        "List this account's 内容检测/AI tasks (most recent first). " +
        "Returns each task's label, status (处理中/已完成/已停止), rate and completion. Read-only.",
      parameters: ListSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "job_list");
        if ("error" in keyed) {
          return keyed.error;
        }
        const params: Record<string, FieldValue> = {
          workspace: DEFAULT_WORKSPACE,
          page: Math.max(1, Number(rawParams.page ?? 1) || 1),
          size: Math.min(50, Math.max(1, Number(rawParams.size ?? 10) || 10)),
          q: asString(rawParams.q),
        };
        let res: Record<string, unknown>;
        try {
          res = await getJson(config, "/ai/fetch-jobs", params, keyed.apiKey);
        } catch (error) {
          return failure(api, "job_list", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const jobs = Array.isArray(res.jobs) ? (res.jobs as Record<string, unknown>[]) : [];
        const list = jobs.map((job) => {
          const status = asString(job.status) ?? "";
          return {
            label: asString(job.label) ?? null,
            status,
            statusLabel: JOB_STATUS_LABELS[status] ?? status,
            rate: Number(job.rate ?? 0),
            completion: Number(job.completion ?? 0),
            date: asString(job.date) ?? null,
          };
        });
        return jsonResult({ success: true, total: Number(res.total ?? list.length), list });
      },
    };
  };
}

export function createJobStopToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "job_stop",
      label: "Stop 检测 Task",
      description:
        "Stop the most recent in-progress 内容检测 task for this account (refunds its credit). " +
        "Call with no arguments — it targets the latest task. Returns the stopped task's label.",
      parameters: EmptySchema,
      async execute(_toolCallId: string) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "job_stop");
        if ("error" in keyed) {
          return keyed.error;
        }
        let jobId: number | null;
        try {
          jobId = await resolveLatestJobId(config, keyed.apiKey);
        } catch (error) {
          return failure(api, "job_stop", userId, error);
        }
        if (!jobId) {
          return jsonResult({ success: false, error: "No recent task to stop." });
        }
        let res: Record<string, unknown>;
        try {
          res = await postForm(config, `/ai/stop-job/${jobId}`, {}, keyed.apiKey);
        } catch (error) {
          return failure(api, "job_stop", userId, error);
        }
        if (res.code !== "success") {
          return jsonResult({ success: false, error: asString(res.message) ?? "Backend rejected the stop request." });
        }
        const job = (res.job as Record<string, unknown> | undefined) ?? {};
        return jsonResult({ success: true, label: asString(job.label) ?? null });
      },
    };
  };
}

export function createLetterGenerateToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "letter_generate",
      label: "Generate 维权文书",
      description:
        "Generate 维权/举报/投诉/公函 letters for the most recent 内容检测 task, from a description of the violations (errors). " +
        "Runs asynchronously — call letter_fetch to retrieve them once ready. " +
        "The errors text must be at least 20 chars or the backend rejects it as too minor.",
      parameters: LetterGenerateSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "letter_generate");
        if ("error" in keyed) {
          return keyed.error;
        }
        const errors = asString(rawParams.errors);
        if (!errors || errors.length < 20) {
          return jsonResult({
            success: false,
            error: "errors must be a description of the violations, at least 20 characters.",
          });
        }
        let jobId: number | null;
        try {
          jobId = await resolveLatestJobId(config, keyed.apiKey);
        } catch (error) {
          return failure(api, "letter_generate", userId, error);
        }
        if (!jobId) {
          return jsonResult({
            success: false,
            error: "No recent 内容检测 task to attach the letters to; run a check first.",
          });
        }
        const fields: Record<string, FieldValue> = {
          errors,
          jobId,
          siteId: config.siteId,
          all: rawParams.all ? 1 : undefined,
        };
        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/ai/generate-letter", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "letter_generate", userId, error);
        }
        if (res.code !== "success") {
          // e.g. "文章违规程度较低，无法生成撤稿函"
          return jsonResult({ success: false, error: asString(res.message) ?? "Backend rejected the request." });
        }
        return jsonResult({
          success: true,
          submitted: true,
          message: asString(res.message) ?? "正在生成，请稍等！",
          agentInstruction:
            "维权文书生成任务已提交。请立刻告知用户文书正在后台生成，稍后可询问我取回文书。不要调用任何工具——等用户主动询问时再用 letter_fetch 获取。",
        });
      },
    };
  };
}

export function createLetterFetchToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "letter_fetch",
      label: "Fetch 维权文书",
      description:
        "Fetch completed 维权/举报/投诉/公函 letters for the most recent 内容检测 task. Call with no arguments. " +
        "⚠️ SINGLE-USE PER TURN: call EXACTLY ONCE, then immediately reply to the user. " +
        "If count is 0, tell the user generation is still running and STOP — never call again in the same turn.",
      parameters: EmptySchema,
      async execute(_toolCallId: string) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "letter_fetch");
        if ("error" in keyed) {
          return keyed.error;
        }
        let jobId: number | null;
        try {
          jobId = await resolveLatestJobId(config, keyed.apiKey);
        } catch (error) {
          return failure(api, "letter_fetch", userId, error);
        }
        if (!jobId) {
          return jsonResult({ success: false, error: "No recent 内容检测 task to fetch letters for." });
        }
        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/ai/fetch-letters", { jobId, siteId: config.siteId }, keyed.apiKey);
        } catch (error) {
          return failure(api, "letter_fetch", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const map = res.letterMap;
        const entries =
          map && typeof map === "object" && !Array.isArray(map)
            ? Object.entries(map as Record<string, unknown>)
            : [];
        const letters = entries.map(([category, value]) => {
          const v = (value as Record<string, unknown>) ?? {};
          return {
            category,
            categoryLabel: LETTER_LABELS[category] ?? category,
            content: asString(v.content) ?? null,
          };
        });
        return jsonResult({
          success: true,
          count: letters.length,
          letters,
          agentInstruction:
            letters.length > 0
              ? "文书已生成，请向用户展示结果。"
              : "⚠️ 文书仍在生成中。请立刻告知用户「文书正在生成，稍后可再询问」并结束本轮对话。禁止再次调用此工具。",
        });
      },
    };
  };
}
