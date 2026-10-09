import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function buildFeishuThreadingToolContext({
  context,
  hasRepliedRef,
}: {
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  return {
    // Internal trigger IDs identify runs, not Feishu messages that can be replied to.
    // Explicit undefined prevents core from falling back to that trigger ID.
    currentMessageId:
      typeof context.CurrentMessageId === "string" &&
      context.CurrentMessageId.trim().startsWith("om_")
        ? context.CurrentMessageId.trim()
        : undefined,
    currentChannelId:
      normalizeOptionalString(context.NativeChannelId) ?? normalizeOptionalString(context.To),
    currentChatType:
      context.ChatType === "direct" ||
      context.ChatType === "group" ||
      context.ChatType === "channel"
        ? context.ChatType
        : undefined,
    currentMessagingTarget: normalizeOptionalString(context.To),
    currentThreadTs: context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
    hasRepliedRef,
  };
}
