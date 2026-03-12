import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
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
    input_value?: string;
    name?: string;
    form_value?: Record<string, unknown>;
    option?: string;
    options?: string[];
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

  const action = event.action;
  const actionValue = action.value;
  const hasFormData = action.form_value !== undefined ||
    action.input_value !== undefined ||
    action.option !== undefined ||
    action.options !== undefined;

  let content = "";

  if (hasFormData) {
    // Form submission or input component — build structured payload
    const payload: Record<string, unknown> = {
      action: action.tag,
      value: actionValue,
    };
    if (action.form_value !== undefined) payload.form_value = action.form_value;
    if (action.input_value !== undefined) payload.input_value = action.input_value;
    if (action.name !== undefined) payload.name = action.name;
    if (action.option !== undefined) payload.option = action.option;
    if (action.options !== undefined) payload.options = action.options;
    content = JSON.stringify(payload);
  } else {
    // Simple button click — preserve existing behavior
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
