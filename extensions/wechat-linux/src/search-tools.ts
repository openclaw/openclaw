import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-runtime";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveWechatLinuxAccount } from "./accounts.js";
import { resolveWechatLinuxBridgeTarget, searchWechatLinuxBridgeHistory } from "./bridge.js";
import { buildWechatLinuxBodyForAgent } from "./normalize.js";
import type { BridgeMessage, BridgeSearchKind, BridgeSearchResult, CoreConfig } from "./types.js";

type WechatLinuxToolContext = {
  config?: CoreConfig;
  agentAccountId?: string | null;
};

const SEARCH_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Optional text to match in WeChat history. Leave empty to fetch recent results.",
    },
    chat: {
      type: "string",
      description: "Optional WeChat chat id or display name. Searches all chats when omitted.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Maximum number of results to return.",
    },
    scan_limit: {
      type: "integer",
      minimum: 1,
      maximum: 5000,
      description: "How many recent messages per chat to scan before filtering.",
    },
  },
  additionalProperties: false,
} as const;

function readOptionalInteger(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const camelKey = key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
  const raw = params[key] ?? params[camelKey];
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number.parseInt(raw.trim(), 10)
        : NaN;
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

function formatTimestamp(timestamp: number, fallback?: string): string {
  if (fallback?.trim()) {
    return fallback.trim();
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "unknown time";
  }
  return new Date(timestamp * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function trimSnippet(value: string, max = 280): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function formatMatchSummary(match: BridgeMessage, index: number): string {
  const lines = [
    `${index + 1}. [${formatTimestamp(match.timestamp, match.time)}] ${match.chat_name} / ${match.sender_display}`,
  ];
  const body = trimSnippet(buildWechatLinuxBodyForAgent(match));
  if (body) {
    lines.push(body);
  }
  const firstMediaPath = match.media_paths?.find((value) => value.trim());
  if (firstMediaPath) {
    lines.push(`附件: ${firstMediaPath}`);
  }
  return lines.join("\n");
}

export function formatWechatLinuxSearchSummary(result: BridgeSearchResult): string {
  const kindLabel =
    result.search_kind === "file" ? "文件" : result.search_kind === "image" ? "图片" : "消息";
  const scope = result.chat_name ?? result.chat_id ?? "全部会话";
  if (!result.ok) {
    return `微信${kindLabel}搜索失败: ${result.note ?? "unknown error"}`;
  }
  if (result.matches.length === 0) {
    return `微信${kindLabel}搜索无结果\n范围: ${scope}\n查询: ${result.query || "[recent]"}`;
  }
  return [
    `微信${kindLabel}搜索命中 ${result.matches.length}/${result.total} 条`,
    `范围: ${scope}`,
    `查询: ${result.query || "[recent]"}`,
    `扫描: ${result.scanned}`,
    "",
    ...result.matches.map((match, index) => formatMatchSummary(match, index)),
  ].join("\n");
}

function createWechatLinuxSearchTool(params: {
  kind: BridgeSearchKind;
  name: string;
  label: string;
  description: string;
}): (ctx: WechatLinuxToolContext) => AnyAgentTool {
  return (ctx) =>
    ({
      name: params.name,
      label: params.label,
      description: params.description,
      parameters: SEARCH_TOOL_PARAMETERS,
      execute: async (_toolCallId, rawParams) => {
        const toolParams =
          rawParams && typeof rawParams === "object"
            ? (rawParams as Record<string, unknown>)
            : ({} as Record<string, unknown>);
        const config = ctx.config as CoreConfig | undefined;
        if (!config) {
          return jsonResult({ ok: false, error: "OpenClaw config unavailable" });
        }

        const account = resolveWechatLinuxAccount({
          cfg: config,
          accountId: ctx.agentAccountId ?? undefined,
        });
        if (!account.enabled || !account.configured) {
          return jsonResult({
            ok: false,
            error: "wechat-linux channel is not configured for this agent account",
          });
        }

        const query = readStringParam(toolParams, "query", { allowEmpty: true }) ?? "";
        const chatInput = readStringParam(toolParams, "chat");
        const limit = readOptionalInteger(toolParams, "limit", 5, 20);
        const scanLimit = readOptionalInteger(toolParams, "scan_limit", 400, 5000);

        let chatId: string | undefined;
        if (chatInput) {
          const resolved = await resolveWechatLinuxBridgeTarget({
            account,
            input: chatInput,
          });
          if (!resolved.ok || !resolved.chat_id) {
            return jsonResult({
              ok: false,
              error: resolved.note || `unable to resolve WeChat chat: ${chatInput}`,
            });
          }
          chatId = resolved.chat_id;
        }

        const result = await searchWechatLinuxBridgeHistory({
          account,
          searchKind: params.kind,
          query,
          chatId,
          limit,
          scanLimit,
        });
        return {
          content: [{ type: "text", text: formatWechatLinuxSearchSummary(result) }],
          details: result,
        };
      },
    }) as AnyAgentTool;
}

export function registerWechatLinuxSearchTools(api: OpenClawPluginApi): void {
  api.registerTool(
    (ctx) => [
      createWechatLinuxSearchTool({
        kind: "message",
        name: "wechat_search_messages",
        label: "WeChat Search Messages",
        description:
          "Search recent WeChat message history across one chat or all chats on the active wechat-linux account.",
      })(ctx),
      createWechatLinuxSearchTool({
        kind: "file",
        name: "wechat_search_files",
        label: "WeChat Search Files",
        description:
          "Search recent WeChat file messages and return matching file entries from the active wechat-linux account.",
      })(ctx),
      createWechatLinuxSearchTool({
        kind: "image",
        name: "wechat_search_images",
        label: "WeChat Search Images",
        description:
          "Search recent WeChat image messages, including OCR/caption text when image analysis is enabled.",
      })(ctx),
    ],
    {
      names: ["wechat_search_messages", "wechat_search_files", "wechat_search_images"],
      optional: true,
    },
  );
}
