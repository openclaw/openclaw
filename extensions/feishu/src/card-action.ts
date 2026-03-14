import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { createFeishuClient } from "./client.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    form_value?: Record<string, unknown>;
    tag: string;
  };
  context: {
    open_id: string;
    user_id: string;
    open_chat_id?: string;
    open_message_id?: string;
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

  // Extract action value; merge form_value when present (form submit)
  const actionValue = event.action.value;
  const formValue = event.action.form_value;
  const hasFormValue = formValue != null && Object.keys(formValue).length > 0;
  const mergedValue = hasFormValue ? { ...actionValue, ...formValue } : actionValue;

  let content = "";
  if (typeof mergedValue === "object" && mergedValue !== null) {
    if (hasFormValue) {
      // Form submit: serialize the full merged object so the agent receives all fields;
      // inject _card_message_id so downstream skills can update the original card
      const withCardId = event.context.open_message_id
        ? { ...mergedValue, _card_message_id: event.context.open_message_id }
        : mergedValue;
      content = JSON.stringify(withCardId);
    } else if ("text" in mergedValue && typeof mergedValue.text === "string") {
      content = mergedValue.text;
    } else if ("command" in mergedValue && typeof mergedValue.command === "string") {
      content = mergedValue.command;
    } else {
      content = JSON.stringify(mergedValue);
    }
  } else {
    content = String(mergedValue);
  }

  // Resolve chat_type via Feishu API — card.action.trigger events do not include
  // chat_type, and open_chat_id uses the oc_ prefix for both group and p2p chats
  const chatId = event.context.open_chat_id || event.operator.open_id;
  let chatType: "p2p" | "group" = "p2p"; // safe default

  if (event.context.open_chat_id) {
    try {
      const client = createFeishuClient(account);
      const res = await client.im.chat.get({
        path: { chat_id: event.context.open_chat_id },
      });
      // chat_type = visibility (public/private), chat_mode = session type (group/p2p/topic)
      if (res.code === 0 && res.data?.chat_mode === "group") {
        chatType = "group";
      }
    } catch {
      // API failure → safe fallback to p2p
    }
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
      message_id: event.context.open_message_id ?? `card-action-${event.token}`,
      chat_id: chatId,
      chat_type: chatType,
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
