import {
  buildCanonicalSentMessageHookContext,
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";

type EmitMessageSentHookParams = {
  sessionKeyForInternalHooks?: string;
  chatId: string;
  accountId?: string;
  content: string;
  success: boolean;
  error?: string;
  messageId?: number;
  isGroup?: boolean;
  groupId?: string;
};

export function emitTelegramMessageSentHooks(params: EmitMessageSentHookParams): void {
  const hookRunner = getGlobalHookRunner();
  const enabled = hookRunner?.hasHooks("message_sent") ?? false;
  if (!enabled && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildCanonicalSentMessageHookContext({
    to: params.chatId,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "telegram",
    accountId: params.accountId,
    conversationId: params.chatId,
    sessionKey: params.sessionKeyForInternalHooks,
    messageId: typeof params.messageId === "number" ? String(params.messageId) : undefined,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });
  if (enabled) {
    fireAndForgetHook(
      Promise.resolve(
        hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      "telegram: message_sent plugin hook failed",
    );
  }
  if (params.sessionKeyForInternalHooks) {
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
}

/** Keep plugin hook routing aligned with the actual Telegram delivery session. */
export async function runTelegramMessageSendingHook(
  hookRunner: ReturnType<typeof getGlobalHookRunner>,
  params: {
    chatId: string;
    accountId?: string;
    sessionKey?: string;
    content: string;
    replyToId?: number;
    threadId?: number;
    mediaUrls: string[];
  },
) {
  return hookRunner?.runMessageSending(
    {
      to: params.chatId,
      content: params.content,
      replyToId: params.replyToId,
      threadId: params.threadId,
      metadata: { channel: "telegram", mediaUrls: params.mediaUrls, threadId: params.threadId },
    },
    {
      channelId: "telegram",
      accountId: params.accountId,
      conversationId: params.chatId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    },
  );
}
