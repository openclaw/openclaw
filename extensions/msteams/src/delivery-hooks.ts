/**
 * MS Teams outbound `message:sent` hook emission.
 *
 * Mirrors the telegram pattern in
 * `extensions/telegram/src/bot/delivery.replies.ts`
 * (`buildTelegramSentHookContext` / `emitInternalMessageSentHook` /
 * `emitMessageSentHooks` / `emitTelegramMessageSentHooks`).
 *
 * Without this module, the msteams reply-dispatcher's outbound path bypasses
 * the internal hook bus AND the plugin-SDK `message_sent` hook entirely,
 * leaving downstream listeners (e.g. audit-loggers, second-brain memory
 * substrates) unable to observe the agent's replies.
 *
 * `to` convention (matches telegram's `chatId` semantics):
 *   - Personal DM:  Azure AD object ID of the recipient user.
 *   - Group / channel:  Bot Framework conversation id (`19:xxx@thread.tacv2`).
 *
 * Hook handlers can disambiguate via `isGroup` + `groupId`.
 */

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

export type EmitMSTeamsMessageSentHookParams = {
  /**
   * The agent's session key. When unset, the internal-hook emission is skipped
   * (the internal bus requires a session key for routing).
   */
  sessionKeyForInternalHooks?: string;
  /**
   * Recipient identifier.
   *   - Personal DM:  AAD object ID of the recipient user.
   *   - Group / channel:  Bot Framework conversation id.
   * Matches telegram's `chatId` semantics for the canonical `to` field.
   */
  to: string;
  /** Bot Framework conversation id; always set for traceability. */
  conversationId?: string;
  /** Bot Framework account id / msteams app id. */
  accountId?: string;
  /** Concatenated text of all rendered messages in this delivery batch. */
  content: string;
  /** Whether the batch was successfully delivered (at least one message accepted). */
  success: boolean;
  /** Error description when `success === false`. */
  error?: string;
  /** First delivered Bot Framework message id (when available). */
  messageId?: string;
  /** Whether this was sent to a group / channel context (mirror semantics). */
  isGroup?: boolean;
  /** Group id (e.g. teamId or chat id) when `isGroup === true`. */
  groupId?: string;
};

function buildMSTeamsSentHookContext(params: EmitMSTeamsMessageSentHookParams) {
  return buildCanonicalSentMessageHookContext({
    to: params.to,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "msteams",
    accountId: params.accountId,
    conversationId: params.conversationId ?? params.to,
    // Include the session key in the canonical hook context (not just as the
    // internal-hook routing key) so plugin-SDK consumers reading the
    // canonical/plugin context object can correlate the sent event with
    // the originating agent session.
    sessionKey: params.sessionKeyForInternalHooks,
    messageId: params.messageId,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });
}

export function emitInternalMessageSentHook(
  params: EmitMSTeamsMessageSentHookParams,
): void {
  if (!params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildMSTeamsSentHookContext(params);
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks,
        toInternalMessageSentContext(canonical),
      ),
    ),
    "msteams: message:sent internal hook failed",
  );
}

function emitMessageSentHooks(
  params: EmitMSTeamsMessageSentHookParams & {
    hookRunner: ReturnType<typeof getGlobalHookRunner>;
    enabled: boolean;
  },
): void {
  if (!params.enabled && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildMSTeamsSentHookContext(params);
  if (params.enabled) {
    fireAndForgetHook(
      Promise.resolve(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      "msteams: message_sent plugin hook failed",
    );
  }
  emitInternalMessageSentHook(params);
}

export function emitMSTeamsMessageSentHooks(
  params: EmitMSTeamsMessageSentHookParams,
): void {
  const hookRunner = getGlobalHookRunner();
  emitMessageSentHooks({
    ...params,
    hookRunner,
    enabled: hookRunner?.hasHooks("message_sent") ?? false,
  });
}
