import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ChannelPlugin } from "../runtime-api.js";
import { normalizeFeishuTarget } from "./targets.js";
import { normalizeFeishuNativeMessageId, resolveFeishuReplyTransport } from "./threading-reply.js";

export const feishuThreading: NonNullable<ChannelPlugin["threading"]> = {
  matchesToolContextTarget: ({ target, toolContext }) => {
    const normalizedTarget = normalizeFeishuTarget(target);
    if (!normalizedTarget) {
      return false;
    }
    return [toolContext.currentChannelId, toolContext.currentMessagingTarget].some(
      (currentTarget) =>
        currentTarget !== undefined && normalizeFeishuTarget(currentTarget) === normalizedTarget,
    );
  },
  buildToolContext: ({ context, hasRepliedRef }) => ({
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
    // Explicit undefined tells the shared threading owner to reject the
    // generic trigger-ID fallback (internal UUIDs are not Feishu messages).
    currentMessageId: normalizeFeishuNativeMessageId(context.CurrentMessageId),
    hasRepliedRef,
  }),
  resolveReplyTransport: resolveFeishuReplyTransport,
};
