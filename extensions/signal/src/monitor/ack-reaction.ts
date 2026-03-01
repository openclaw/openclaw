/**
 * Sends an instant ACK reaction on inbound Signal messages when reactionLevel === "ack".
 * Call this BEFORE inboundDebouncer.enqueue() in event-handler.ts.
 */

import { shouldAckReaction } from "../../channels/ack-reactions.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { resolveSignalReactionLevel } from "../reaction-level.js";
import { sendReactionSignal } from "../send-reactions.js";

export function maybeSendSignalAckReaction(params: {
  cfg: OpenClawConfig;
  senderRecipient: string;
  targetTimestamp: number;
  isGroup: boolean;
  groupId?: string;
  baseUrl: string;
  account?: string;
  accountId: string;
}): void {
  const { ackEnabled } = resolveSignalReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!ackEnabled) {
    return;
  }

  const emoji = (params.cfg.messages?.ackReaction ?? "👀").trim();
  if (!emoji) {
    return;
  }

  const scope = params.cfg.messages?.ackReactionScope;
  const shouldSend = shouldAckReaction({
    scope,
    isDirect: !params.isGroup,
    isGroup: params.isGroup,
    isMentionableGroup: false,
    requireMention: false,
    canDetectMention: false,
    effectiveWasMentioned: false,
    shouldBypassMention: false,
  });
  if (!shouldSend) {
    return;
  }

  sendReactionSignal(params.senderRecipient, params.targetTimestamp, emoji, {
    baseUrl: params.baseUrl,
    account: params.account,
    accountId: params.accountId,
    groupId: params.groupId,
  }).catch((err) => {
    logVerbose(`Signal ack reaction failed: ${String(err)}`);
  });
}
