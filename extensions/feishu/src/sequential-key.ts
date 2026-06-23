// Feishu plugin module implements sequential key behavior.
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import { resolveFeishuGroupSession } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import type { FeishuConfig, FeishuMessageInfo } from "./types.js";
import { isFeishuGroupChatType } from "./types.js";

const TOPIC_THREAD_HYDRATION_TIMEOUT_MS = 1_500;

function isTopicSessionScope(scope: string): boolean {
  return scope === "group_topic" || scope === "group_topic_sender";
}

export type FeishuSequentialKeyResult =
  | string
  | {
      key: string;
      event?: FeishuMessageEvent;
      waitForTaskBeforeNextChatKey?: boolean;
    };

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
  cfg?: ClawdbotConfig;
  feishuCfg?: FeishuConfig;
  fetchMessage?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string;
    messageId: string;
  }) => Promise<FeishuMessageInfo | null>;
  log?: (...args: unknown[]) => void;
}): FeishuSequentialKeyResult | Promise<FeishuSequentialKeyResult> {
  const { accountId, event, botOpenId, botName, feishuCfg } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";
  const baseKey = `feishu:${accountId}:${chatId}`;
  const parsed = parseFeishuMessageEvent(event, botOpenId, botName);
  const text = parsed.content.trim();

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  if (!isFeishuGroupChatType(parsed.chatType)) {
    return baseKey;
  }

  const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: parsed.chatId });
  const resolveSession = (threadId?: string) =>
    resolveFeishuGroupSession({
      chatId: parsed.chatId,
      senderOpenId: parsed.senderOpenId,
      messageId: parsed.messageId,
      rootId: parsed.rootId,
      threadId,
      chatType: parsed.chatType,
      groupConfig,
      feishuCfg,
    });
  const formatKey = (session: ReturnType<typeof resolveSession>) =>
    `feishu:${accountId}:${session.peerId}`;

  const eventThreadId = parsed.threadId?.trim();
  const eventSession = resolveSession(eventThreadId);
  const resolveKey = (threadId?: string) => {
    const groupSession = threadId === eventThreadId ? eventSession : resolveSession(threadId);
    return `feishu:${accountId}:${groupSession.peerId}`;
  };

  if (
    parsed.chatType !== "topic_group" ||
    eventThreadId ||
    !isTopicSessionScope(eventSession.groupSessionScope) ||
    !params.cfg ||
    !params.fetchMessage
  ) {
    return formatKey(eventSession);
  }

  return raceWithTimeoutAndAbort(
    params.fetchMessage({
      cfg: params.cfg,
      accountId,
      messageId: parsed.messageId,
    }),
    { timeoutMs: TOPIC_THREAD_HYDRATION_TIMEOUT_MS },
  )
    .then((result) => {
      if (result.status !== "resolved") {
        params.log?.(
          `feishu[${accountId}]: timed out hydrating topic thread_id before queue key for message=${parsed.messageId}`,
        );
        return {
          key: resolveKey(eventThreadId),
          waitForTaskBeforeNextChatKey: true,
        };
      }
      const hydratedThreadId = result.value?.threadId?.trim();
      if (hydratedThreadId) {
        return {
          key: resolveKey(hydratedThreadId),
          event: {
            ...event,
            message: {
              ...event.message,
              thread_id: hydratedThreadId,
            },
          },
        };
      }
      return {
        key: resolveKey(eventThreadId),
        waitForTaskBeforeNextChatKey: true,
      };
    })
    .catch((err: unknown) => {
      params.log?.(
        `feishu[${accountId}]: failed to hydrate topic thread_id before queue key for message=${parsed.messageId}: ${String(err)}`,
      );
      return {
        key: resolveKey(eventThreadId),
        waitForTaskBeforeNextChatKey: true,
      };
    });
}
