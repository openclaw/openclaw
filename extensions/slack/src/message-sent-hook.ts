// Slack plugin module implements message_sent hook emission.
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

export type EmitSlackMessageSentHookParams = {
  sessionKeyForInternalHooks?: string;
  runId?: string;
  to: string;
  accountId?: string | null;
  content: string;
  success: boolean;
  error?: string;
  messageId?: string;
  isGroup?: boolean;
  groupId?: string;
};

export function emitSlackMessageSentHooks(params: EmitSlackMessageSentHookParams): void {
  const sessionKey = params.sessionKeyForInternalHooks;
  const hookRunner = getGlobalHookRunner();
  const emitPluginHook = hookRunner?.hasHooks("message_sent") ?? false;
  if (!emitPluginHook && !sessionKey) {
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
    sessionKey,
    runId: params.runId,
    messageId: params.messageId,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });

  if (emitPluginHook && hookRunner) {
    fireAndForgetHook(
      Promise.resolve(
        hookRunner.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      "slack: message_sent plugin hook failed",
    );
  }

  if (sessionKey) {
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "sent",
          sessionKey,
          toInternalMessageSentContext(canonical),
        ),
      ),
      "slack: message:sent internal hook failed",
    );
  }
}
