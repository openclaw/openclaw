import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { sendMessageFeishu } from "./send.js";
import { getStreamingText } from "./streaming-text-cache.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  context: {
    open_id: string;
    user_id: string;
    chat_id: string;
  };
};

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;

  // Extract action value
  const actionValue = event.action.value;
  let content = "";
  if (typeof actionValue === "object" && actionValue !== null) {
    if ("text" in actionValue && typeof actionValue.text === "string") {
      content = actionValue.text;
    } else if ("command" in actionValue && typeof actionValue.command === "string") {
      content = actionValue.command;
    } else {
      content = JSON.stringify(actionValue);
    }
  } else {
    content = String(actionValue);
  }

  // Handle "Show full text" button: re-send cached streaming card content as
  // a plain message instead of dispatching to the agent session.
  if (content === "__show_full_text__") {
    const messageId =
      typeof actionValue === "object" && actionValue !== null
        ? (actionValue.message_id as string | undefined)
        : undefined;
    const to = event.context.chat_id
      ? `chat:${event.context.chat_id}`
      : `user:${event.operator.open_id}`;
    log(
      `feishu[${account.accountId}]: show-full-text requested by ${event.operator.open_id} for message=${messageId ?? "unknown"}`,
    );
    if (messageId) {
      const fullText = getStreamingText(messageId);
      if (fullText) {
        await sendMessageFeishu({ cfg, to, text: fullText, accountId });
      } else {
        await sendMessageFeishu({
          cfg,
          to,
          text: "\u26A0\uFE0F \u7F13\u5B58\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u63D0\u95EE\u3002",
          accountId,
        });
      }
    }
    return;
  }

  // Construct a synthetic message event
  const messageEvent: FeishuMessageEvent = {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: `card-action-${event.token}`,
      chat_id: event.context.chat_id || event.operator.open_id,
      chat_type: event.context.chat_id ? "group" : "p2p",
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
  };

  log(
    `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
  );

  // Dispatch as normal message
  await handleFeishuMessage({
    cfg,
    event: messageEvent,
    botOpenId: params.botOpenId,
    runtime,
    accountId,
  });
}
