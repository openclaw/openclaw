import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getAccessToken } from "../api.js";
import { listQQBotAccountIds, resolveQQBotAccount } from "../config.js";
import { debugError, debugLog } from "../utils/debug-log.js";

const API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_TIMEOUT_MS = 30000;

interface ChannelApiParams {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}

const ChannelApiSchema = {
  type: "object",
  properties: {
    method: {
      type: "string",
      description: "HTTP 请求方法。可选值：GET, POST, PUT, PATCH, DELETE",
      enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    },
    path: {
      type: "string",
      description:
        "API 路径（不含域名），占位符需替换为实际值。" +
        "示例：/users/@me/guilds, /guilds/{guild_id}/channels, /channels/{channel_id}",
    },
    body: {
      type: "object",
      description: "请求体（JSON），用于 POST/PUT/PATCH 请求。GET/DELETE 请求不需要此参数。",
    },
    query: {
      type: "object",
      description:
        "URL 查询参数（键值对），会拼接到路径后面。" +
        '如 { "limit": "100", "after": "0" } 会拼接为 ?limit=100&after=0',
      additionalProperties: { type: "string" },
    },
  },
  required: ["method", "path"],
} as const;

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function buildUrl(path: string, query?: Record<string, string>): string {
  let url = `${API_BASE}${path}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, value);
      }
    }
    const qs = params.toString();
    if (qs) {
      url += `?${qs}`;
    }
  }
  return url;
}

function validatePath(path: string): string | null {
  if (!path.startsWith("/")) {
    return "path 必须以 / 开头";
  }
  if (path.includes("..") || path.includes("//")) {
    return "path 不允许包含 .. 或 //";
  }
  if (!/^\/[a-zA-Z0-9\-._~:@!$&'()*+,;=/%]+$/.test(path) && path !== "/") {
    return "path 包含非法字符";
  }
  return null;
}

/**
 * 注册 QQ 频道 API 代理工具。
 *
 * 该工具作为 QQ 开放平台频道 API 的 HTTP 代理，自动处理 Token 鉴权。
 * AI 通过 skill 文档了解各接口的路径、方法和参数，构造请求后由此工具代理发送。
 */
export function registerChannelTool(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) {
    debugLog("[qqbot-channel-api] No config available, skipping");
    return;
  }

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) {
    debugLog("[qqbot-channel-api] No QQBot accounts configured, skipping");
    return;
  }

  const firstAccountId = accountIds[0];
  const account = resolveQQBotAccount(cfg, firstAccountId);

  if (!account.appId || !account.clientSecret) {
    debugLog("[qqbot-channel-api] Account not fully configured, skipping");
    return;
  }

  api.registerTool(
    {
      name: "qqbot_channel_api",
      label: "QQBot Channel API",
      description:
        "QQ 开放平台频道 API HTTP 代理，自动填充鉴权 Token。" +
        "常用接口速查：" +
        "频道列表 GET /users/@me/guilds | " +
        "子频道列表 GET /guilds/{guild_id}/channels | " +
        "子频道详情 GET /channels/{channel_id} | " +
        "创建子频道 POST /guilds/{guild_id}/channels | " +
        "成员列表 GET /guilds/{guild_id}/members?after=0&limit=100 | " +
        "成员详情 GET /guilds/{guild_id}/members/{user_id} | " +
        "帖子列表 GET /channels/{channel_id}/threads | " +
        "发帖 PUT /channels/{channel_id}/threads | " +
        "创建公告 POST /guilds/{guild_id}/announces | " +
        "创建日程 POST /channels/{channel_id}/schedules。" +
        "更多接口和参数详情请阅读 qqbot-channel skill。",
      parameters: ChannelApiSchema,
      async execute(_toolCallId, params) {
        const p = params as ChannelApiParams;
        if (!p.method) {
          return json({ error: "method 为必填参数" });
        }
        if (!p.path) {
          return json({ error: "path 为必填参数" });
        }

        const method = p.method.toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          return json({
            error: `不支持的 HTTP 方法: ${method}，可选值：GET, POST, PUT, PATCH, DELETE`,
          });
        }

        const pathError = validatePath(p.path);
        if (pathError) {
          return json({ error: pathError });
        }

        if ((method === "GET" || method === "DELETE") && p.body && Object.keys(p.body).length > 0) {
          debugLog(`[qqbot-channel-api] ${method} request with body, body will be ignored`);
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const url = buildUrl(p.path, p.query);
          const headers: Record<string, string> = {
            Authorization: `QQBot ${accessToken}`,
            "Content-Type": "application/json",
          };

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

          const fetchOptions: RequestInit = {
            method,
            headers,
            signal: controller.signal,
          };

          if (p.body && ["POST", "PUT", "PATCH"].includes(method)) {
            fetchOptions.body = JSON.stringify(p.body);
          }

          debugLog(`[qqbot-channel-api] >>> ${method} ${url} (timeout: ${DEFAULT_TIMEOUT_MS}ms)`);

          let res: Response;
          try {
            res = await fetch(url, fetchOptions);
          } catch (err) {
            clearTimeout(timeoutId);
            if (err instanceof Error && err.name === "AbortError") {
              debugError(`[qqbot-channel-api] <<< Request timeout after ${DEFAULT_TIMEOUT_MS}ms`);
              return json({ error: `请求超时（${DEFAULT_TIMEOUT_MS}ms）`, path: p.path });
            }
            debugError("[qqbot-channel-api] <<< Network error:", err);
            return json({
              error: `网络错误: ${err instanceof Error ? err.message : String(err)}`,
              path: p.path,
            });
          } finally {
            clearTimeout(timeoutId);
          }

          debugLog(`[qqbot-channel-api] <<< Status: ${res.status} ${res.statusText}`);

          const rawBody = await res.text();
          if (!rawBody || rawBody.trim() === "") {
            if (res.ok) {
              return json({ success: true, status: res.status, path: p.path });
            }
            return json({
              error: `API 返回 ${res.status} ${res.statusText}`,
              status: res.status,
              path: p.path,
            });
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            parsed = rawBody;
          }

          if (!res.ok) {
            const errMsg =
              typeof parsed === "object" && parsed && "message" in parsed
                ? String((parsed as { message?: unknown }).message)
                : `${res.status} ${res.statusText}`;
            debugError(`[qqbot-channel-api] Error [${method} ${p.path}]: ${errMsg}`);
            return json({
              error: errMsg,
              status: res.status,
              path: p.path,
              details: parsed,
            });
          }

          return json({
            success: true,
            status: res.status,
            path: p.path,
            data: parsed,
          });
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
            path: p.path,
          });
        }
      },
    },
    { name: "qqbot_channel_api" },
  );
}
