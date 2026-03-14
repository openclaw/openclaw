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
    name?: string;
    option?: string;
    options?: string[];
    input_value?: string;
    form_value?: Record<string, unknown>;
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

  // Extract action value — include interactive component fields when present
  const actionValue = event.action.value;
  const hasExtraFields =
    event.action.name !== undefined ||
    event.action.form_value !== undefined ||
    event.action.input_value !== undefined ||
    event.action.option !== undefined ||
    event.action.options !== undefined;

  let content = "";
  // Preserve command/text extraction so slash-commands stay parseable by handleFeishuMessage,
  // even when extra fields like `name` are present.
  if (
    typeof actionValue === "object" &&
    actionValue !== null &&
    "text" in actionValue &&
    typeof actionValue.text === "string"
  ) {
    content = actionValue.text;
  } else if (
    typeof actionValue === "object" &&
    actionValue !== null &&
    "command" in actionValue &&
    typeof actionValue.command === "string"
  ) {
    content = actionValue.command;
  } else if (hasExtraFields) {
    // Build a structured payload so the agent receives all form/input data
    const payload: Record<string, unknown> = {
      action: event.action.tag,
      value: actionValue,
    };
    if (event.action.form_value !== undefined) payload.form_value = event.action.form_value;
    if (event.action.input_value !== undefined) payload.input_value = event.action.input_value;
    if (event.action.name !== undefined) payload.name = event.action.name;
    if (event.action.option !== undefined) payload.option = event.action.option;
    if (event.action.options !== undefined) payload.options = event.action.options;
    content = JSON.stringify(payload);
  } else if (typeof actionValue === "object" && actionValue !== null) {
    content = JSON.stringify(actionValue);
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
