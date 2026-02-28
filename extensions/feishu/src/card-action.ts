import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";

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
