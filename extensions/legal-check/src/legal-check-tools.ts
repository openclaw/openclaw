
import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { extractUrl } from "./extract-url.js";
import { getJson, LegalApiError, postForm, resolveConfig } from "./http-client.js";
import { ApiKeyResolver } from "./key-resolver.js";
import { RecentJobStore } from "./recent-jobs.js";
import type { LegalApiConfig } from "./types.js";

/** Chat agents are named `rabbitmq-<userId>`; that userId is the trusted identity. */
const RABBITMQ_AGENT_PATTERN = /^rabbitmq-(.+)$/;


function extractUserId(agentId: string | undefined): string | null {
  const match = RABBITMQ_AGENT_PATTERN.exec(agentId ?? "");
  return match?.[1] ?? null;
}

function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

const CreateSchema = Type.Object(
  {
    content: Type.String({
      description:
        "The 图文/视频 to check: a public URL, OR the pasted title+text. If it contains a URL " +
        "the backend crawls it; otherwise it analyzes the pasted text. (Web 上传视频 is not supported here.)",
    }),
    mode: Type.Optional(
      stringEnum(
        ["violation", "rumor"] as const,
        '"violation" (违规检测, default) flags illegal/non-compliant content; ' +
          '"rumor" (不实信息检测) checks against a known truth you provide.',
      ),
    ),
    target: Type.Optional(
      Type.String({ description: "维权主体 (the aggrieved party). Optional." }),
    ),
    truth: Type.Optional(
      Type.String({
        description:
          'rumor mode only: the verified truth ("真相详情"). Required when mode="rumor".',
      }),
    ),
    verifiedBy: Type.Optional(
      Type.String({
        description:
          'rumor mode only: the unit that verified the truth ("核实单位"). Required when mode="rumor".',
      }),
    ),
    gov: Type.Optional(
      Type.Boolean({ description: "Also prepare the government-report letter. Default false." }),
    ),
  },
  { additionalProperties: false },
);

const StatusSchema = Type.Object(
  {
    jobId: Type.Optional(
      Type.Number({
        description:
          "Internal — leave unset. The tool polls the most recent check for this account on its own.",
      }),
    ),
  },
  { additionalProperties: false },
);

const STATUS_LABELS: Record<string, string> = {
  Pending: "排队中",
  Running: "检测中",
  Summary: "生成报告中",
  Done: "已完成",
  Fail: "失败",
  Stop: "已停止",
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Map a backend error/login envelope to a tool error, or null when it looks OK. */
function envelopeError(res: Record<string, unknown>): string | null {
  if (res.login) {
    return "Backend rejected the request (not authorized for this account).";
  }
  if (res.code === "danger") {
    return asString(res.message) ?? "Backend returned an error.";
  }
  return null;
}

export function createLegalCheckCreateToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentJobStore,
) {
  const config = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }

    return {
      name: "legal_check_create",
      label: "Create Legal Check",
      description:
        "Create a 图文/视频违规检测 or 不实信息检测 task (the same engine as the web 内容检测 page). " +
        "The analysis runs asynchronously — call legal_check_status (no arguments) to poll the result. " +
        "Each check consumes the account's legal-check credit. " +
        "The job is tracked server-side; never mention any internal job id or number to the user.",
      parameters: CreateSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        let apiKey: string;
        try {
          apiKey = await resolver.getApiKey(userId);
        } catch (error) {
          api.logger.error(
            `[LEGAL_CHECK_CREATE] key resolution failed for ${userId}: ${String(error)}`,
          );
          return jsonResult({
            success: false,
            error:
              "Could not resolve an API key for this account; ask the operator to check legal-check config.",
          });
        }
        const content = asString(rawParams.content);
        if (!content) {
          return jsonResult({
            success: false,
            error: "content is required (a URL or the text to check).",
          });
        }
        const mode = rawParams.mode === "rumor" ? "rumor" : "violation";
        if (mode === "rumor") {
          if (!asString(rawParams.truth) || !asString(rawParams.verifiedBy)) {
            return jsonResult({
              success: false,
              error: 'mode="rumor" requires both truth (真相详情) and verifiedBy (核实单位).',
            });
          }
        }

        const fields: Record<string, string | number | undefined> = {
          requirement: content,
          link: extractUrl(content),
          upload: 0,
          rumor: mode === "rumor" ? 1 : 0,
          target: asString(rawParams.target) ?? "",
          data: asString(rawParams.truth) ?? "",
          officialUnit: asString(rawParams.verifiedBy) ?? "",
          gov: rawParams.gov ? 1 : 0,
          regular: 1,
          clientIp: "127.0.0.1",
          siteId: "legal",
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/legal/save-job", fields, apiKey);
        } catch (error) {
          return failure(api, "legal_check_create", userId, error);
        }

        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }

        const job = (res.job as Record<string, unknown> | undefined) ?? undefined;
        const jobId = Number(job?.id);
        if (!Number.isInteger(jobId) || jobId <= 0) {
          return jsonResult({ success: false, error: "Backend did not return a job id." });
        }
        const label = asString(job?.label) ?? null;
        // Keep the id server-side only; legal_check_status polls it back.
        store.remember(userId, { jobId, label, mode });
        return jsonResult({
          success: true,
          submitted: true,
          duplicated: Boolean(res.duplicated),
          label,
          mode,
          detailPath: `/business/content/${jobId}`,
          agentInstruction:
            "内容检测任务已提交成功，后台正在检测中，通常需要数分钟。请立刻告知用户任务已提交，稍后可询问检测结果。不要现在就调用 legal_check_status——等用户主动询问时再查。",
        });
      },
    };
  };
}

export function createLegalCheckStatusToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentJobStore,
) {
  const config = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }

    return {
      name: "legal_check_status",
      label: "Legal Check Status",
      description:
        "Get the status and result of the most recent 违规/不实信息检测. Call with no arguments. " +
        "⚠️ SINGLE-USE PER TURN: call EXACTLY ONCE per user request, then immediately reply to the user — " +
        "regardless of whether the check is done. NEVER call this tool a second time in the same turn.",
      parameters: StatusSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        let apiKey: string;
        try {
          apiKey = await resolver.getApiKey(userId);
        } catch (error) {
          api.logger.error(
            `[LEGAL_CHECK_STATUS] key resolution failed for ${userId}: ${String(error)}`,
          );
          return jsonResult({
            success: false,
            error:
              "Could not resolve an API key for this account; ask the operator to check legal-check config.",
          });
        }
        // The agent never holds the id; default to the latest job we created.
        const jobId =
          rawParams.jobId != null ? Number(rawParams.jobId) : (store.latest(userId)?.jobId ?? 0);
        if (!Number.isInteger(jobId) || jobId <= 0) {
          return jsonResult({
            success: false,
            error: "No recent check to poll; create one with legal_check_create first.",
          });
        }

        let res: Record<string, unknown>;
        try {
          res = await getJson(
            config,
            "/ai/fetch-job",
            { id: jobId, workspace: "pr", all: 1 },
            apiKey,
          );
        } catch (error) {
          return failure(api, "legal_check_status", userId, error);
        }

        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }

        return jsonResult(summarizeJob(jobId, res));
      },
    };
  };
}

function summarizeJob(jobId: number, res: Record<string, unknown>): Record<string, unknown> {
  const job = (res.job as Record<string, unknown> | undefined) ?? {};
  const detail = (res.detail as Record<string, unknown> | undefined) ?? {};
  const status = asString(job.status) ?? "";
  const letterMap = (res.letterMap as Record<string, unknown> | undefined) ?? {};
  const tableData = detail.tableData;
  const paragraphCount = Array.isArray(tableData)
    ? tableData.length
    : tableData && typeof tableData === "object"
      ? Object.keys(tableData).length
      : 0;

  const done = status === "Done";
  const failed = status === "Fail";
  const stopped = status === "Stop";
  const terminal = done || failed || stopped;

  return {
    success: true,
    status,
    statusLabel: STATUS_LABELS[status] ?? status ?? "未知",
    ...(terminal ? { done, failed, stopped } : {}),
    label: asString(job.label) ?? null,
    mode: Number(job.rumor) === 1 ? "rumor" : "violation",
    target: asString(job.target) ?? null,
    result: detail.result ?? null,
    paragraphCount,
    letters: Object.keys(letterMap),
    detailPath: `/business/content/${jobId}`,
    agentInstruction: terminal
      ? "检测已完成，请向用户展示检测结果。如有违规且用户希望维权，可用 letter_generate 生成文书。"
      : "⚠️ 检测仍在进行中。请立刻向用户报告当前进度并结束本轮对话。禁止再次调用此工具或任何其他工具。",
  };
}

function failure(api: OpenClawPluginApi, tool: string, userId: string, error: unknown) {
  if (error instanceof LegalApiError) {
    api.logger.warn(`[${tool.toUpperCase()}] backend error for ${userId}: ${error.message}`);
    return jsonResult({ success: false, error: `Backend request failed: ${error.message}` });
  }
  api.logger.error(`[${tool.toUpperCase()}] failed for ${userId}: ${String(error)}`);
  return jsonResult({ success: false, error: "Request to the backend failed; see gateway logs." });
}

export type { LegalApiConfig };
