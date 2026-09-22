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
