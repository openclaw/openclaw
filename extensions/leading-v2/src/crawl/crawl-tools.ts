import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, getJson, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import type { RecentTaskStore } from "../client/recent-tasks.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";
import { getChatMercureTopic } from "../notify/chat-topic.js";
import type { PendingTaskRegistry } from "../notify/pending-store.js";
import type { NotifyConfig, NotifyToolContext } from "../notify/types.js";
import { submitCrawlRefresh } from "./crawl-submit.js";

/** What we remember per user so crawl_refresh_status can poll without exposing the uuid. */
export interface RecentCrawlRefresh {
  uuid: string;
  name: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "抓取中",
  done: "已完成",
  failed: "失败",
  stop: "已停止",
};

const RECORD_STATUS_LABELS: Record<string, string> = {
  success: "成功",
  no_data: "无数据",
  failed: "失败",
  manual_pending: "待人工",
};

const FeedSnapshot = Type.Object(
  {
    feedId: Type.Number({ description: "看板舆情条目 id (from feed_list)." }),
    url: Type.String({ description: "The item's URL — this is what gets re-crawled." }),
    title: Type.Optional(Type.String()),
    contentType: Type.Optional(Type.String({ description: "图文 / 视频 / 评论." })),
    level: Type.Optional(Type.String({ description: "评级 (Red/Orange/Yellow/Blue)." })),
    offline: Type.Optional(Type.Boolean()),
    platform: Type.Optional(Type.String()),
    author: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CreateSchema = Type.Object(
  {
    links: Type.Optional(
      Type.Union([Type.Array(Type.String()), Type.String()], {
        description:
          "URLs to re-crawl for fresh 互动量. Array or newline-separated string. Provide this OR feeds.",
      }),
    ),
    feeds: Type.Optional(
      Type.Array(FeedSnapshot, {
        description:
          "监测方案条目 to refresh (typically from feed_list). Requires topicId. Their urls are crawled automatically.",
      }),
    ),
    topicId: Type.Optional(Type.Number({ description: "监测方案 id — required when feeds is given." })),
    name: Type.Optional(Type.String({ description: "Task name; auto-named with a timestamp if omitted." })),
  },
  { additionalProperties: false },
);

const StatusSchema = Type.Object(
  {
    uuid: Type.Optional(
      Type.String({
        description: "Internal — leave unset. Polls the most recent 互动量刷新 task for this account.",
      }),
    ),
  },
  { additionalProperties: false },
);

const ListSchema = Type.Object(
  {
    status: Type.Optional(Type.String({ description: "Filter by status (pending/running/done/failed)." })),
    q: Type.Optional(Type.String({ description: "Keyword filter on task name." })),
    page: Type.Optional(Type.Number({ description: "Page number, 1-based. Default 1." })),
    size: Type.Optional(Type.Number({ description: "Page size. Default 20." })),
  },
  { additionalProperties: false },
);

export function createCrawlRefreshCreateToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentCrawlRefresh>,
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
      name: "crawl_refresh_create",
      label: "互动量刷新 / Refresh Engagement",
      description:
        "Refresh the 互动量 (转/评/赞/阅/藏) of links or 监测方案条目 by re-crawling them on the backend. " +
        "Provide links (URLs) and/or feeds (条目 from feed_list, with topicId). Read-only: it reports the fresh " +
        "numbers but does NOT write them back to the 看板. Runs asynchronously — call crawl_refresh_status to poll. " +
        "Tracked server-side; never mention any internal id/uuid to the user.",
      parameters: CreateSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        // Notification addressing: prefer ctx.sessionKey; if only sessionId is
        // exposed, reconstruct the chat-pipeline key.
        const sessionKey =
          ctx.sessionKey ??
          (ctx.sessionId ? `agent:rabbitmq-${userId}:rabbitmq:${userId}:${ctx.sessionId}` : undefined);
        const willNotify = notify.enabled && Boolean(sessionKey);

        const result = await submitCrawlRefresh({
          config,
          resolver,
          registry,
          userId,
          params: {
            links: rawParams.links as string[] | string | undefined,
            feeds: rawParams.feeds as Array<Record<string, unknown>> | undefined,
            topicId: rawParams.topicId as number | undefined,
            name: rawParams.name as string | undefined,
          },
          notify:
            willNotify && sessionKey
              ? {
                  sessionKey,
                  mercureTopic: getChatMercureTopic(userId) ?? userId,
                  delivery: ctx.deliveryContext ?? {},
                  ttlMs: notify.ttlMs,
                }
              : undefined,
        });

        if (!result.ok) {
          return jsonResult({ success: false, error: result.error });
        }
        store.remember(userId, { uuid: result.uuid, name: result.name });
        return jsonResult({
          success: true,
          submitted: true,
          name: result.name,
          linkCount: result.linkCount,
          message: result.message,
          agentInstruction: willNotify
            ? "互动量刷新任务已提交成功。任务在后台抓取真实页面，通常需要数分钟甚至更久。" +
              "完成后系统会自动通知用户，无需用户追问、也不要调用状态查询工具——你现在只需告诉用户「任务已提交，抓好后会自动告诉你」。"
            : "互动量刷新任务已提交成功。请立刻告知用户任务正在后台抓取，重抓真实页面通常需要数分钟甚至更久。不要调用状态查询工具——等用户主动询问进度时再用 crawl_refresh_status 查询。",
        });
      },
    };
  };
}

export function createCrawlRefreshStatusToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  store: RecentTaskStore<RecentCrawlRefresh>,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "crawl_refresh_status",
      label: "互动量刷新 Status",
      description:
        "Get the progress and fresh 互动量 of the most recent 互动量刷新 task. Call with no arguments. " +
        "⚠️ SINGLE-USE PER TURN: call EXACTLY ONCE per user request, then immediately reply — " +
        "regardless of whether the task is done. NEVER call this tool a second time in the same turn.",
      parameters: StatusSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "crawl_refresh_status");
        if ("error" in keyed) {
          return keyed.error;
        }
        const uuid = asString(rawParams.uuid) ?? store.latest(userId)?.uuid;
        if (!uuid) {
          return jsonResult({
            success: false,
            error: "No recent 互动量刷新 task to poll; create one with crawl_refresh_create first.",
          });
        }

        let detail: Record<string, unknown>;
        try {
          detail = await getJson(config, "/link-data-crawler/detail", { uuid }, keyed.apiKey);
        } catch (error) {
          return failure(api, "crawl_refresh_status", userId, error);
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

        let list: Array<Record<string, unknown>> = [];
        if (done) {
          let records: Record<string, unknown>;
          try {
            records = await getJson(config, "/link-data-crawler/fetch-records", { uuid }, keyed.apiKey);
          } catch (error) {
            return failure(api, "crawl_refresh_status", userId, error);
          }
          const rows = Array.isArray(records.list) ? (records.list as Record<string, unknown>[]) : [];
          list = rows.map((r) => {
            const rs = (asString(r.status) ?? "").toLowerCase();
            return {
              url: asString(r.url) ?? null,
              platform: asString(r.platform) ?? null,
              status: RECORD_STATUS_LABELS[rs] ?? rs,
              转发: Number(r.repost_count ?? 0),
              分享: Number(r.share_count ?? 0),
              评论: Number(r.comment_count ?? 0),
              点赞: Number(r.like_count ?? 0),
              阅读: Number(r.read_count ?? 0),
              收藏: Number(r.collect_count ?? 0),
              粉丝: Number(r.follower_count ?? 0),
              scrapedAt: asString(r.scraped_at) ?? null,
            };
          });
        }

        return jsonResult({
          success: true,
          status,
          statusLabel: STATUS_LABELS[status] ?? status ?? "未知",
          ...(terminal ? { done, failed, stopped } : {}),
          name: store.latest(userId)?.name ?? null,
          total: list.length,
          list,
          agentInstruction: terminal
            ? "任务已结束，请向用户展示最新互动量。无数据/失败的链接如实说明，不要编造数值。"
            : "⚠️ 任务仍在抓取中。请立刻向用户报告当前进度并结束本轮对话。禁止再次调用此工具或任何其他工具。",
        });
      },
    };
  };
}

export function createCrawlRefreshListToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "crawl_refresh_list",
      label: "List 互动量刷新 Tasks",
      description:
        "List this account's 互动量刷新 tasks (most recent first), optionally filtered by status or keyword. " +
        "Use it when the user asks which refresh tasks exist or to find an earlier one.",
      parameters: ListSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "crawl_refresh_list");
        if ("error" in keyed) {
          return keyed.error;
        }
        const params: Record<string, FieldValue> = {
          status: asString(rawParams.status),
          q: asString(rawParams.q),
          page: Math.max(1, Number(rawParams.page ?? 1) || 1),
          size: Math.min(100, Math.max(1, Number(rawParams.size ?? 20) || 20)),
        };

        let res: Record<string, unknown>;
        try {
          res = await getJson(config, "/link-data-crawler/list", params, keyed.apiKey);
        } catch (error) {
          return failure(api, "crawl_refresh_list", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const rawList = Array.isArray(res.list) ? (res.list as Record<string, unknown>[]) : [];
        const list = rawList.map((item) => {
          const status = (asString(item.status) ?? "").toLowerCase();
          return {
            name: asString(item.name) ?? null,
            status,
            statusLabel: STATUS_LABELS[status] ?? status,
            total: Number(item.total_links ?? item.total ?? 0),
            createdAt: asString(item.created_at) ?? null,
          };
        });
        return jsonResult({ success: true, total: Number(res.total ?? list.length), list });
      },
    };
  };
}
