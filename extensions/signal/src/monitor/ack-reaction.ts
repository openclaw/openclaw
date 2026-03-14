/**
 * Sends an instant ACK reaction on inbound Signal messages when reactionLevel === "ack".
 * Call this BEFORE inboundDebouncer.enqueue() in event-handler.ts.
 */

import { resolveAckReaction } from "../../../../src/agents/identity.js";
import { shouldAckReaction } from "../../../../src/channels/ack-reactions.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { logVerbose } from "../../../../src/globals.js";
import { resolveSignalReactionLevel } from "../reaction-level.js";
import { sendReactionSignal } from "../send-reactions.js";

export function maybeSendSignalAckReaction(params: {
  cfg: OpenClawConfig;
  agentId: string;
  senderRecipient: string;
  targetTimestamp: number;
  isGroup: boolean;
  groupId?: string;
  /** Whether the agent was mentioned in the message (for group-mentions scope gating). */
  wasMentioned?: boolean;
  /** Whether mention detection is configured (i.e. mention patterns exist). */
  canDetectMention?: boolean;
  /** Whether group requires a mention before responding (for group-mentions scope gating). */
  requireMention?: boolean;
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

  const emoji = resolveAckReaction(params.cfg, params.agentId, {
    channel: "signal",
    accountId: params.accountId,
  }).trim();
  if (!emoji) {
    return;
  }

  const scope = params.cfg.messages?.ackReactionScope;
  const canDetectMention = params.canDetectMention ?? false;
  const requireMention = params.requireMention ?? false;
  const wasMentioned = params.wasMentioned ?? false;
  const shouldSend = shouldAckReaction({
    scope,
    isDirect: !params.isGroup,
    isGroup: params.isGroup,
    isMentionableGroup: params.isGroup && canDetectMention,
    requireMention,
    canDetectMention,
    effectiveWasMentioned: wasMentioned,
    shouldBypassMention: !requireMention,
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
