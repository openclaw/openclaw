import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, getJson, postForm, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import type { RecentTaskStore } from "../client/recent-tasks.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";
import { getChatMercureTopic } from "../notify/chat-topic.js";
import type { PendingTaskRegistry } from "../notify/pending-store.js";
import type { NotifyConfig, NotifyToolContext } from "../notify/types.js";

/**
 * What we remember per user so link_batch_status can poll without exposing the
 * task uuid. The 失效链接强化检测 backend (LinkDataCrawler module) keys every
 * read by uuid, so that is what we keep.
 */
export interface RecentLinkBatch {
  uuid: string;
  label: string | null;
}

/** crawl_task.status values. */
const STATUS_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "检测中",
  done: "已完成",
  failed: "失败",
  stop: "已停止",
};

/** crawl_check_record.verdict values (set by the Python check_worker). */
const VERDICT_LABELS: Record<string, string> = {
  invalid: "失效",
  valid: "正常",
  blocked: "被拦截",
  unknown: "无法判定",
};

const MAX_LINKS = 1000;

const CreateSchema = Type.Object(
  {
    links: Type.Union([Type.Array(Type.String()), Type.String()], {
      description:
        "The links to check for dead/失效 status. Either an array of URLs or a newline-separated string. " +
        `Duplicates are removed. Max ${MAX_LINKS} links per task.`,
    }),
    label: Type.String({
      description: "A short task name for this batch (失效链接检测任务名), max 255 chars.",
    }),
  },
  { additionalProperties: false },
);

const StatusSchema = Type.Object(
  {
    uuid: Type.Optional(
      Type.String({
        description:
          "Internal — leave unset. The tool polls the most recent link check for this account on its own.",
      }),
    ),
  },
  { additionalProperties: false },
);

function normalizeLinks(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map((x) => String(x).trim())
    : typeof raw === "string"
      ? raw.split(/\r?\n/).map((x) => x.trim())
      : [];
  const valid = list.filter((u) => /^https?:\/\//i.test(u));
  return [...new Set(valid)];
}

export function createLinkBatchCreateToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentLinkBatch>,
  registry: PendingTaskRegistry,
  notify: NotifyConfig,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: NotifyToolContext) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "link_batch_create",
      label: "Create Link Batch Check",
      description:
        "Submit a batch of links for 失效链接强化检测 (the same engine as the web 失效链接强化检测). " +
        "Each link is fetched and rendered on the backend crawler, then judged 失效/正常/被拦截/无法判定. " +
        "Detection runs asynchronously — call link_batch_status (no arguments) to poll progress and per-link results. " +
        "The task is tracked server-side; never mention any internal task id/uuid to the user.",
      parameters: CreateSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "link_batch_create");
        if ("error" in keyed) {
          return keyed.error;
        }
        const links = normalizeLinks(rawParams.links);
        if (links.length === 0) {
          return jsonResult({ success: false, error: "links is required (one or more http(s) URLs)." });
        }
        if (links.length > MAX_LINKS) {
          return jsonResult({
            success: false,
            error: `Too many links (max ${MAX_LINKS} per task); split into multiple batches.`,
          });
        }
        const label = asString(rawParams.label);
        if (!label) {
          return jsonResult({ success: false, error: "label is required (a short task name)." });
        }

        const fields: Record<string, FieldValue> = {
          name: label.slice(0, 255),
          links: links.join("\n"),
          siteId: config.siteId,
        };

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/link-data-crawler/add-check-task", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "link_batch_create", userId, error);
        }

        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const uuid = asString(res.uuid);
        if (!uuid) {
          return jsonResult({ success: false, error: "Backend did not return a task id." });
        }
        store.remember(userId, { uuid, label });

        // Register for background completion notification (same flow as
        // 互动量刷新): the CompletionNotifier polls this task and pushes the
        // verdict summary when it finishes, so the user need not keep asking.
        const sessionKey =
          ctx.sessionKey ??
          (ctx.sessionId ? `agent:rabbitmq-${userId}:rabbitmq:${userId}:${ctx.sessionId}` : undefined);
        const willNotify = notify.enabled && Boolean(sessionKey);
        if (willNotify && sessionKey) {
          const now = Date.now();
          registry.add({
            id: `link_check:${uuid}`,
            kind: "link_check",
            uid: userId,
            backendId: uuid,
            sessionKey,
            mercureTopic: getChatMercureTopic(userId) ?? userId,
            delivery: ctx.deliveryContext ?? {},
            title: label,
            createdAt: now,
            attempts: 0,
            notified: false,
            expiresAt: now + notify.ttlMs,
          });
        }

        return jsonResult({
          success: true,
          submitted: true,
          label,
          linkCount: Number(res.total ?? links.length),
          message: asString(res.message) ?? "检测任务已提交",
          agentInstruction: willNotify
            ? "失效链接强化检测任务已提交成功。任务在后台逐条检测，通常需要数分钟。" +
              "完成后系统会自动通知用户，无需用户追问、也不要调用状态查询工具——你现在只需告诉用户「任务已提交，检测完会自动告诉你」。"
            : "失效链接强化检测任务已提交成功。请立刻告知用户任务正在后台逐条检测，通常需要数分钟。" +
              "不要调用任何状态查询工具——等用户主动询问进度时再用 link_batch_status 查询。",
        });
      },
    };
  };
}

export function createLinkBatchStatusToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentLinkBatch>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "link_batch_status",
      label: "Link Batch Status",
      description:
        "Get the progress and per-link results of the most recent 失效链接强化检测 batch. Call with no arguments. " +
        "Returns each link's verdict (失效/正常/被拦截/无法判定) with the判定依据 once available. " +
        "⚠️ SINGLE-USE PER TURN: call this tool EXACTLY ONCE per user request, then immediately " +
        "reply to the user with the result — regardless of whether the task is done. " +
        "NEVER call this tool a second time in the same turn.",
      parameters: StatusSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "link_batch_status");
        if ("error" in keyed) {
          return keyed.error;
        }
        const uuid = asString(rawParams.uuid) ?? store.latest(userId)?.uuid;
        if (!uuid) {
          return jsonResult({
            success: false,
            error: "No recent link check to poll; create one with link_batch_create first.",
          });
        }

        let detail: Record<string, unknown>;
        try {
          detail = await getJson(config, "/link-data-crawler/detail", { uuid }, keyed.apiKey);
        } catch (error) {
          return failure(api, "link_batch_status", userId, error);
        }
        const detailErr = envelopeError(detail);
        if (detailErr) {
          return jsonResult({ success: false, error: detailErr });
        }
        const task = (detail.task as Record<string, unknown> | undefined) ?? {};
        const status = (asString(task.status) ?? "").toLowerCase();
        const done = status === "done";
        const failed = status === "failed";
        const stopped = status === "stop";
        const terminal = done || failed || stopped;
        const linksTotal = Number(task.total_links ?? 0);
        const checkedTotal = Number(task.done_links ?? 0);

        // Per-link verdicts: available as soon as the worker has checked anything,
        // so fetch unless the task is still queued.
        let list: Array<Record<string, unknown>> = [];
        if (status && status !== "pending") {
          let records: Record<string, unknown>;
          try {
            records = await getJson(
              config,
              "/link-data-crawler/fetch-check-results",
              { uuid },
              keyed.apiKey,
            );
          } catch (error) {
            return failure(api, "link_batch_status", userId, error);
          }
          const recordsErr = envelopeError(records);
          if (recordsErr) {
            return jsonResult({ success: false, error: recordsErr });
          }
          const rows = Array.isArray(records.list) ? (records.list as Record<string, unknown>[]) : [];
          list = rows.map((r) => {
            const verdict = (asString(r.verdict) ?? "").toLowerCase();
            return {
              url: asString(r.url) ?? null,
              verdict,
              verdictLabel: VERDICT_LABELS[verdict] ?? verdict ?? "未判定",
              statusType: asString(r.status_type) ?? null,
              httpStatus: r.http_status != null ? Number(r.http_status) : null,
              reason: asString(r.reason) ?? null,
              checkedAt: asString(r.checked_at) ?? null,
            };
          });
        }
        const offlineTotal = list.filter((r) => r.verdict === "invalid").length;

        return jsonResult({
          success: true,
          status,
          statusLabel: STATUS_LABELS[status] ?? status ?? "未知",
          ...(terminal ? { done, failed, stopped } : {}),
          label: store.latest(userId)?.label ?? null,
          linksTotal,
          checkedTotal,
          offlineTotal,
          total: list.length,
          list,
          agentInstruction: terminal
            ? "检测已结束，请向用户展示每条链接的判定结果。失效/被拦截/无法判定的链接如实说明判定依据，不要编造。"
            : "⚠️ 检测仍在进行中。请立刻向用户报告当前进度并结束本轮对话。禁止再次调用此工具或任何其他工具。",
        });
      },
    };
  };
}
