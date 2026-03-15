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
    option?: string;
    options?: string[];
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

  // Extract action content — check component-specific fields before falling
  // through to the generic value.text / value.command path.
  const actionValue = event.action.value ?? {};
  let content = "";

  // Interactive components: when the static value includes a command/text
  // routing key, preserve it as the content so downstream command detection
  // still works.  Attach the dynamic user input as structured metadata that
  // the agent can inspect without breaking command probing.
  const hasCommand =
    typeof actionValue === "object" &&
    actionValue !== null &&
    "command" in actionValue &&
    typeof actionValue.command === "string";
  const hasText =
    typeof actionValue === "object" &&
    actionValue !== null &&
    "text" in actionValue &&
    typeof actionValue.text === "string";

  // Build content from interactive user input.  For slash commands, append
  // the user's selection as inline args so `normalizeCommandBody` (which
  // strips after the first newline) can still pass them to command handlers
  // that accept args.  Commands that do NOT accept args will fail the
  // command regex, causing the message to fall through to the agent as
  // plain text — which is the correct behaviour because the agent still
  // sees the full content including the selection data.
  const buildInteractiveContent = (base: string, data: Record<string, unknown>): string => {
    // For single-select, use the option value as a natural arg.
    const option = data.option;
    if (typeof option === "string" && Object.keys(data).length === 1) {
      return base.startsWith("/") ? `${base} ${option}` : `${base} ${option}`;
    }
    const jsonStr = JSON.stringify(data);
    return `${base} ${jsonStr}`;
  };

  if (event.action.form_value && typeof event.action.form_value === "object") {
    if (hasCommand) {
      content = buildInteractiveContent(actionValue.command as string, {
        form_value: event.action.form_value,
      });
    } else if (hasText) {
      content = buildInteractiveContent(actionValue.text as string, {
        form_value: event.action.form_value,
      });
    } else {
      const merged = { ...actionValue, form_value: event.action.form_value };
      content = JSON.stringify(merged);
    }
  }
  // multi-select (checkbox): merge options array into value
  else if (Array.isArray(event.action.options)) {
    if (hasCommand) {
      content = buildInteractiveContent(actionValue.command as string, {
        options: event.action.options,
      });
    } else if (hasText) {
      content = buildInteractiveContent(actionValue.text as string, {
        options: event.action.options,
      });
    } else {
      const merged = { ...actionValue, options: event.action.options };
      content = JSON.stringify(merged);
    }
  }
  // single-select (select_static dropdown): merge option into value
  else if (typeof event.action.option === "string") {
    if (hasCommand) {
      content = buildInteractiveContent(actionValue.command as string, {
        option: event.action.option,
      });
    } else if (hasText) {
      content = buildInteractiveContent(actionValue.text as string, {
        option: event.action.option,
      });
    } else {
      const merged = { ...actionValue, option: event.action.option };
      content = JSON.stringify(merged);
    }
  }
  // button: existing text / command / JSON fallback
  else if (typeof actionValue === "object" && actionValue !== null) {
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
