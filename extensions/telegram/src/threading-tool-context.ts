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
}): ChannelThreadingToolContext {
  // Extract thread ID from MessageThreadId (forum topics only)
  const threadId = params.context.MessageThreadId;

  // For forum topics, To is "group:-100..." — extract the bare chat ID.
  // For DMs, use the raw chat ID directly.
  const toValue = params.context.To ?? "";
  const parsedTo = parseTelegramTarget(toValue);
  const currentChannelId = parsedTo.chatId || undefined;

  // Always return toolContext with currentChannelId and hasRepliedRef
  // Only include currentThreadTs for forum topics (when MessageThreadId exists)
  return {
    currentChannelId,
    currentThreadTs: threadId != null ? String(threadId) : undefined,
    hasRepliedRef: params.hasRepliedRef,
  };
}
