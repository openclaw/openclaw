import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { parseTelegramTarget } from "./targets.js";

export function buildTelegramThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext | undefined {
  // Extract thread ID from MessageThreadId (forum topics)
  const threadId = params.context.MessageThreadId;

  // For forum topics, To is "group:-100..." — extract the bare chat ID.
  // For DMs, use the raw chat ID directly.
  const toValue = params.context.To ?? "";
  const parsedTo = parseTelegramTarget(toValue);
  const currentChannelId = parsedTo.chatId;

  // Only return toolContext if we have a valid thread ID
  if (threadId == null) {
    return undefined;
  }

  return {
    currentChannelId,
    currentThreadTs: String(threadId),
    hasRepliedRef: params.hasRepliedRef,
  };
}
