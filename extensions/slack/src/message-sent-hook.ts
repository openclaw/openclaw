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

function buildSlackSentHookContext(params: EmitSlackMessageSentHookParams) {
  return buildCanonicalSentMessageHookContext({
    to: params.to,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "slack",
    accountId: params.accountId ?? undefined,
    conversationId: params.to,
    sessionKey: params.sessionKeyForInternalHooks,
    runId: params.runId,
    messageId: params.messageId,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });
}

function emitInternalSlackMessageSentHook(params: EmitSlackMessageSentHookParams): void {
  if (!params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildSlackSentHookContext(params);
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

function emitMessageSentHooks(
  params: EmitSlackMessageSentHookParams & {
    hookRunner: ReturnType<typeof getGlobalHookRunner>;
    enabled: boolean;
  },
): void {
  if (!params.enabled && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildSlackSentHookContext(params);
  if (params.enabled) {
    fireAndForgetHook(
      Promise.resolve(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      "slack: message_sent plugin hook failed",
    );
  }
  emitInternalSlackMessageSentHook(params);
}

export function emitSlackMessageSentHooks(params: EmitSlackMessageSentHookParams): void {
  const hookRunner = getGlobalHookRunner();
  emitMessageSentHooks({
    ...params,
    hookRunner,
    enabled: hookRunner?.hasHooks("message_sent") ?? false,
  });
}
