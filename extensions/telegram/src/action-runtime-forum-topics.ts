import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  jsonResult,
  readStringOrNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import {
  readTelegramChatId,
  readTelegramForumTopicIconColor,
  readTelegramThreadId,
} from "./action-params.js";
import {
  createForumTopicTelegram,
  deleteForumTopicTelegram,
  editForumTopicTelegram,
} from "./send.js";
import { parseTelegramTarget } from "./targets.js";
import { updateTopicName } from "./topic-name-cache.js";

type TelegramForumTopicActionName = "createForumTopic" | "editForumTopic" | "deleteForumTopic";

function resolveActionTopicNameCacheScope(cfg: OpenClawConfig, accountId?: string | null): string {
  const resolvedAccountId = accountId ?? resolveDefaultTelegramAccountId(cfg);
  return resolveStorePath(cfg.session?.store, {
    agentId: resolveTelegramAccountOwnerAgentId({ cfg, accountId: resolvedAccountId }),
  });
}

/**
 * Shared destination policy admits `to`, while readTelegramChatId prefers `chatId`/`channelId`.
 * Deletion is irreversible, so every supplied destination field must name the same chat and topic.
 */
function assertUnambiguousTopicDeleteDestination(
  input: Record<string, unknown>,
  messageThreadId: number,
): void {
  const chats = new Set<string>();
  for (const key of ["to", "chatId", "channelId"] as const) {
    const raw = readStringOrNumberParam(input, key);
    if (raw === undefined) {
      continue;
    }
    const target = parseTelegramTarget(raw);
    chats.add(target.chatId);
    if (target.messageThreadId !== undefined && target.messageThreadId !== messageThreadId) {
      throw new Error(`Telegram deleteForumTopic ${key} topic conflicts with threadId.`);
    }
  }
  if (chats.size > 1) {
    throw new Error("Telegram deleteForumTopic received conflicting destination chats.");
  }
}

export async function handleTelegramForumTopicAction(params: {
  action: TelegramForumTopicActionName;
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  apiOptions: Omit<Parameters<typeof createForumTopicTelegram>[2], "token">;
  requireToken: () => string;
  isActionEnabled: (key: "createForumTopic" | "editForumTopic" | "deleteMessage") => boolean;
}): Promise<AgentToolResult<unknown>> {
  const { action, params: input, cfg, accountId, apiOptions, requireToken } = params;
  // topic-delete needs both the topic-management and the message-deletion gates; no new config key.
  const gateKeys =
    action === "createForumTopic"
      ? (["createForumTopic"] as const)
      : action === "deleteForumTopic"
        ? (["editForumTopic", "deleteMessage"] as const)
        : (["editForumTopic"] as const);
  if (!gateKeys.every((key) => params.isActionEnabled(key))) {
    throw new Error(`Telegram ${action} is disabled.`);
  }
  const chatId = readTelegramChatId(input);
  if (action === "createForumTopic") {
    const name =
      readStringParam(input, "name") ??
      readStringParam(input, "threadName", { required: true, label: "name" });
    const iconColor = readTelegramForumTopicIconColor(input);
    const iconCustomEmojiId = readStringParam(input, "iconCustomEmojiId");
    const result = await createForumTopicTelegram(chatId ?? "", name, {
      ...apiOptions,
      token: requireToken(),
      iconColor,
      iconCustomEmojiId,
    });
    return jsonResult({
      ok: true,
      topicId: result.topicId,
      name: result.name,
      chatId: result.chatId,
    });
  }
  const messageThreadId = readTelegramThreadId(input);
  if (typeof messageThreadId !== "number") {
    throw new Error("messageThreadId or threadId is required.");
  }
  if (action === "deleteForumTopic") {
    assertUnambiguousTopicDeleteDestination(input, messageThreadId);
    return jsonResult(
      await deleteForumTopicTelegram(chatId ?? "", messageThreadId, {
        ...apiOptions,
        token: requireToken(),
      }),
    );
  }
  const name = readStringParam(input, "name") ?? readStringParam(input, "threadName");
  const iconCustomEmojiId = readStringParam(input, "iconCustomEmojiId");
  const result = await editForumTopicTelegram(chatId ?? "", messageThreadId, {
    ...apiOptions,
    token: requireToken(),
    name,
    iconCustomEmojiId,
  });
  if (result.chatId) {
    const patch = {
      ...(name ? { name } : {}),
      ...(iconCustomEmojiId ? { iconCustomEmojiId } : {}),
    };
    if (Object.keys(patch).length > 0) {
      await updateTopicName(
        result.chatId,
        result.messageThreadId,
        patch,
        resolveActionTopicNameCacheScope(cfg, accountId),
      ).catch(() => {});
    }
  }
  return jsonResult(result);
}
