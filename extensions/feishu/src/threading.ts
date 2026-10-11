import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeFeishuTarget } from "./targets.js";

export const feishuThreadingAdapter = {
  matchesToolContextTarget: ({
    target,
    toolContext,
  }: {
    target: string;
    toolContext: ChannelThreadingToolContext;
  }): boolean => {
    const normalizedTarget = normalizeFeishuTarget(target);
    if (!normalizedTarget) {
      return false;
    }
    return [toolContext.currentChannelId, toolContext.currentMessagingTarget].some(
      (currentTarget) =>
        currentTarget !== undefined && normalizeFeishuTarget(currentTarget) === normalizedTarget,
    );
  },
  buildToolContext: ({
    context,
    hasRepliedRef,
  }: {
    context: ChannelThreadingContext;
    hasRepliedRef?: { value: boolean };
  }): ChannelThreadingToolContext => ({
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
    // Reply and topic APIs address open message ids only. Queued, cron, and cross-session turns
    // are admitted under an internal run id, so the explicit undefined keeps the shared owner
    // from offering it as an implicit anchor.
    currentMessageId:
      typeof context.CurrentMessageId === "string" && context.CurrentMessageId.startsWith("om_")
        ? context.CurrentMessageId
        : undefined,
    hasRepliedRef,
  }),
};
