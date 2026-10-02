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

type EmitSlackMessageSentHookParams = {
  /** Optional canonical session key. When set, the internal `message:sent` hook fires too. */
  sessionKeyForInternalHooks?: string;
  /** Slack target (channel ID `C…`, DM channel ID `D…`, group `G…`, or user ID `U…`). */
  to: string;
  accountId?: string | null;
  /** The outbound content that was sent. Mirrors `MessageSentEvent.content`. */
  content: string;
  success: boolean;
  error?: string;
  /** Slack message `ts` returned by `chat.postMessage` on success. */
  messageId?: string;
  isGroup?: boolean;
  groupId?: string;
};

export function emitSlackMessageSentHooks(params: EmitSlackMessageSentHookParams): void {
  const hookRunner = getGlobalHookRunner();
  const enabled = hookRunner?.hasHooks("message_sent") ?? false;
  if (!enabled && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildCanonicalSentMessageHookContext({
    to: params.to,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "slack",
    accountId: params.accountId ?? undefined,
    conversationId: params.to,
    sessionKey: params.sessionKeyForInternalHooks,
    messageId: params.messageId,
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
      "slack: message_sent plugin hook failed",
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
      "slack: message:sent internal hook failed",
    );
  }
}
