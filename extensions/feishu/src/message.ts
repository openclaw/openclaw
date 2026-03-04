import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuMessageSchema, type FeishuMessageParams } from "./message-schema.js";
import { createFeishuToolClient } from "./tool-account.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

function dateToEpoch(y: number, m: number, d: number, mode: "start" | "end"): string {
  const utcMs =
    mode === "start"
      ? Date.UTC(y, m - 1, d, 0, 0, 0) - CST_OFFSET_MS
      : Date.UTC(y, m - 1, d, 23, 59, 59) - CST_OFFSET_MS;
  return String(Math.floor(utcMs / 1000));
}

/**
 * Parse a time parameter into Unix epoch seconds.
 * Accepts: date string ("2026-03-01"), ISO datetime ("2026-03-01T09:00:00+08:00"),
 * or raw epoch seconds (digits only — logged as warning and kept for back-compat).
 *
 * Bare dates without timezone are treated as Asia/Shanghai (UTC+8).
 * `mode` controls whether a bare date resolves to start-of-day or end-of-day.
 */
function parseTimeParam(value: string, mode: "start" | "end"): string {
  // Raw epoch digits: log a warning (LLM should pass date strings) but accept
  if (/^\d{9,11}$/.test(value)) {
    const d = new Date(Number(value) * 1000 + CST_OFFSET_MS);
    console.error(
      `[parseTimeParam] WARN: raw epoch ${value} received (resolves to ${d.toISOString().slice(0, 10)} CST). ` +
        "LLM should pass date strings like '2026-03-01' instead.",
    );
    return value;
  }

  // Date-only: "2026-03-01" or "2026-3-1"
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return dateToEpoch(y, m, d, mode);
  }

  // ISO string with or without timezone
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return value;
  return String(Math.floor(ms / 1000));
}

type MessageItem = {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type?: string;
  create_time?: string;
  update_time?: string;
  chat_id?: string;
  deleted?: boolean;
  sender?: { id: string; id_type: string; sender_type: string; tenant_key?: string };
  body?: { content: string };
  mentions?: { key: string; id: string; id_type: string; name: string }[];
};

function pickMessageFields(item: MessageItem) {
  const base: Record<string, unknown> = {
    message_id: item.message_id,
    msg_type: item.msg_type,
    create_time: item.create_time,
    chat_id: item.chat_id,
    sender: item.sender,
    body: item.body,
    mentions: item.mentions,
  };
  if (item.thread_id) base.thread_id = item.thread_id;
  if (item.root_id) base.root_id = item.root_id;
  if (item.parent_id) base.parent_id = item.parent_id;
  return base;
}

type LarkApiResponse = {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
};

/**
 * Direct HTTP request to Feishu IM API.
 * Bypasses SDK's internal error swallowing and supports user_access_token override.
 */
async function messageRequest(
  client: Lark.Client,
  opts: {
    method: "GET" | "POST";
    url: string;
    query?: Record<string, string>;
    userToken?: string;
  },
): Promise<LarkApiResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- access SDK internals
  const c = client as any;
  const domain: string = c.domain ?? "https://open.feishu.cn";
  const { headers } = await c.formatPayload({}, {});

  const tokenSource = opts.userToken ? "user_access_token" : "tenant_access_token";
  if (opts.userToken) {
    headers.Authorization = `Bearer ${opts.userToken}`;
  }

  const fullUrl = `${domain}${opts.url}`;
  console.error(
    `[messageRequest] ${opts.method} ${fullUrl} tokenSource=${tokenSource} ` +
      `token=${(headers.Authorization as string)?.slice(0, 20)}... ` +
      `query=${JSON.stringify(opts.query)}`,
  );

  let res: LarkApiResponse;
  try {
    const raw = await c.httpInstance.request({
      method: opts.method,
      url: fullUrl,
      headers,
      params: opts.query,
    });
    res = raw as LarkApiResponse;
  } catch (err: unknown) {
    const resp = (err as { response?: { status?: number; data?: { code?: number; msg?: string } } })
      ?.response;
    const data = resp?.data;
    console.error(
      `[messageRequest] ERROR: status=${resp?.status ?? "n/a"} code=${data?.code ?? "n/a"} ` +
        `msg=${data?.msg ?? String(err)}`,
    );
    if (data && typeof data.code === "number") {
      // Re-use the same error code handling as the normal response path
      res = { code: data.code, msg: data.msg, data: undefined };
    } else if (resp?.status) {
      throw new Error(`Feishu message API: HTTP ${resp.status} ${opts.method} ${opts.url}`);
    } else {
      throw err;
    }
  }

  console.error(
    `[messageRequest] response: code=${res.code} msg=${res.msg ?? "(none)"} ` +
      `hasData=${!!res.data} itemCount=${Array.isArray(res.data?.items) ? (res.data.items as unknown[]).length : "n/a"}`,
  );

  if (res.code !== 0) {
    const code = res.code;
    // Friendly error messages for common Feishu error codes
    if (code === 99991663 || code === 99991664) {
      throw new Error(
        `NOT_AUTHORIZED: Feishu user access token is invalid or expired (code=${code}). ` +
          "User must re-authorize via /feishu-auth command. DO NOT fabricate URLs.",
      );
    }
    if (code === 230002) {
      throw new Error(
        `BOT_NOT_IN_CHAT: The bot is not a member of this chat (code=${code}). ` +
          "Add the bot to the target group first.",
      );
    }
    if (code === 99991679 || code === 230027) {
      throw new Error(
        `PERMISSION_DENIED: Insufficient permissions (code=${code}). ` +
          "Ensure the app has im:message:readonly enabled in Feishu Open Platform > Permissions, " +
          "then re-authorize via /feishu-auth. DO NOT fabricate permission names or URLs.",
      );
    }
    throw new Error(res.msg ?? `Feishu message API error: code=${code}`);
  }

  return res;
}

async function fetchMessages(
  client: Lark.Client,
  opts: {
    containerIdType: "chat" | "thread";
    containerId: string;
    startTime?: string;
    endTime?: string;
    sortType?: string;
    pageSize?: number;
    pageToken?: string;
  },
) {
  const page_size = opts.pageSize ? Math.max(1, Math.min(50, opts.pageSize)) : 20;

  const query: Record<string, string> = {
    container_id_type: opts.containerIdType,
    container_id: opts.containerId,
    page_size: String(page_size),
  };
  // Thread container type does not support time range filtering per Feishu docs
  if (opts.containerIdType === "chat") {
    if (opts.startTime) query.start_time = parseTimeParam(opts.startTime, "start");
    if (opts.endTime) query.end_time = parseTimeParam(opts.endTime, "end");
  }
  if (opts.sortType) query.sort_type = opts.sortType;
  if (opts.pageToken) query.page_token = opts.pageToken;

  const res = await messageRequest(client, {
    method: "GET",
    url: "/open-apis/im/v1/messages",
    query,
  });

  const items = (res.data?.items ?? []) as MessageItem[];
  return {
    has_more: res.data?.has_more as boolean | undefined,
    page_token: res.data?.page_token as string | undefined,
    items,
  };
}

const MAX_THREAD_EXPAND = 5;

/**
 * List messages, optionally auto-expanding threads found in chat results.
 * When container_id_type=chat and expand_threads is true (default), any message
 * with a thread_id gets a `thread_replies` field with the first page of replies.
 */
async function listMessages(
  client: Lark.Client,
  opts: {
    containerIdType: "chat" | "thread";
    containerId: string;
    startTime?: string;
    endTime?: string;
    sortType?: string;
    pageSize?: number;
    pageToken?: string;
    expandThreads?: boolean;
  },
) {
  const result = await fetchMessages(client, opts);

  const picked = result.items.map((item) => pickMessageFields(item));

  // Auto-expand threads when listing chat messages
  if (opts.containerIdType === "chat" && opts.expandThreads !== false) {
    const threadItems = result.items.filter((item) => item.thread_id);
    const toExpand = threadItems.slice(0, MAX_THREAD_EXPAND);

    if (toExpand.length > 0) {
      const threadResults = await Promise.all(
        toExpand.map(async (item) => {
          try {
            const threadRes = await fetchMessages(client, {
              containerIdType: "thread",
              containerId: item.thread_id!,
              pageSize: 20,
            });
            return {
              threadId: item.thread_id!,
              replies: threadRes.items.map((r) => pickMessageFields(r)),
              has_more: threadRes.has_more,
            };
          } catch {
            return { threadId: item.thread_id!, replies: [], error: "failed to fetch" };
          }
        }),
      );

      // Attach thread_replies to the corresponding root messages
      const threadMap = new Map(threadResults.map((t) => [t.threadId, t]));
      for (const msg of picked) {
        const tid = msg.thread_id as string | undefined;
        if (tid && threadMap.has(tid)) {
          const t = threadMap.get(tid)!;
          msg.thread_replies = t.replies;
          if (t.has_more) msg.thread_has_more = true;
        }
      }
    }
  }

  return {
    container_id_type: opts.containerIdType,
    container_id: opts.containerId,
    has_more: result.has_more,
    page_token: result.page_token,
    items: picked,
  };
}

async function getMessage(client: Lark.Client, messageId: string) {
  const res = await messageRequest(client, {
    method: "GET",
    url: `/open-apis/im/v1/messages/${messageId}`,
  });

  const items = (res.data?.items ?? []) as MessageItem[];
  if (items.length === 0) {
    throw new Error(`Message not found: ${messageId}`);
  }

  return pickMessageFields(items[0]);
}

export function registerFeishuMessageTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_message: No config available, skipping message tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_message: No Feishu accounts configured, skipping message tools");
    return;
  }

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.message) {
    api.logger.debug?.("feishu_message: message tool disabled in config");
    return;
  }

  api.registerTool(
    (ctx) => ({
      name: "feishu_message",
      label: "Feishu Message",
      description:
        "Feishu message operations. Actions: list (chat history with optional time range, auto-expands thread replies), " +
        "get (single message by ID). Uses tenant_access_token. The bot must be a member of the target chat.",
      parameters: FeishuMessageSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuMessageParams;
        try {
          const client = createFeishuToolClient({
            api,
            defaultAccountId: ctx.agentAccountId,
          });

          switch (p.action) {
            case "list": {
              const containerType = p.container_id_type ?? "chat";
              const containerId = containerType === "thread" ? p.thread_id : p.chat_id;

              if (!containerId) {
                return json({
                  error:
                    containerType === "thread"
                      ? "thread_id is required for list with container_id_type=thread"
                      : "chat_id is required for list action",
                });
              }

              api.logger.info(
                `feishu_message: list container=${containerType}:${containerId} ` +
                  `start_time=${p.start_time ?? "(none)"} end_time=${p.end_time ?? "(none)"}`,
              );

              return json(
                await listMessages(client, {
                  containerIdType: containerType,
                  containerId,
                  startTime: p.start_time,
                  endTime: p.end_time,
                  sortType: p.sort_type,
                  pageSize: p.page_size,
                  pageToken: p.page_token,
                  expandThreads: p.expand_threads,
                }),
              );
            }
            case "get": {
              if (!p.message_id) {
                return json({ error: "message_id is required for get action" });
              }
              return json(await getMessage(client, p.message_id));
            }
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    }),
    { name: "feishu_message" },
  );

  api.logger.info?.("feishu_message: Registered feishu_message tool");
}
