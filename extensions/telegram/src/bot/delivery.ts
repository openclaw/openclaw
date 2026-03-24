export { deliverReplies } from "./delivery.replies.js";
export { resolveMedia } from "./delivery.resolve-media.js";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
} from "../../../../src/hooks/message-hook-mappers.js";
import { fireAndForgetHook } from "../../../../src/hooks/fire-and-forget.js";
import {
  createInternalHookEvent,
  triggerInternalHook,
} from "../../../../src/hooks/internal-hooks.js";

/** Emit the internal message:sent hook for a completed Telegram delivery. */
export function emitInternalMessageSentHook(params: {
  sessionKeyForInternalHooks: string;
  chatId: string;
  accountId?: string;
  content: string;
  success: boolean;
  error?: string;
  messageId?: number;
  isGroup?: boolean;
  groupId?: string;
}): void {
  const canonical = buildCanonicalSentMessageHookContext({
    to: params.chatId,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "telegram",
    accountId: params.accountId,
    conversationId: params.chatId,
    messageId: typeof params.messageId === "number" ? String(params.messageId) : undefined,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks,
        toInternalMessageSentContext(canonical),
      ),
    ),
    "telegram: message:sent internal hook failed",
  );
}
