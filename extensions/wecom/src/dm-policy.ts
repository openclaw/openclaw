/**
 * WeCom DM (direct message) access control module
 *
 * Handles DM policy checks and pairing flow.
 */

import type { WSClient, WsFrame } from "@wecom/aibot-node-sdk";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { CHANNEL_ID } from "./const.js";
import { isSenderAllowed } from "./group-policy.js";
import { sendWeComReply } from "./message-sender.js";
import { getWeComRuntime } from "./runtime.js";
import type { ResolvedWeComAccount } from "./utils.js";

// ============================================================================
// Check result types
// ============================================================================

/**
 * DM policy check result
 */
export interface DmPolicyCheckResult {
  /** Whether the message is allowed to proceed */
  allowed: boolean;
  /** Whether a pairing message was sent (only in pairing mode) */
  pairingSent?: boolean;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check DM policy access control.
 * @returns Check result indicating whether processing should continue
 */
export async function checkDmPolicy(params: {
  senderId: string;
  isGroup: boolean;
  account: ResolvedWeComAccount;
  wsClient: WSClient;
  frame: WsFrame;
  runtime: RuntimeEnv;
}): Promise<DmPolicyCheckResult> {
  const { senderId, isGroup, account, wsClient, frame, runtime } = params;
  const core = getWeComRuntime();

  // Group messages skip DM policy check
  if (isGroup) {
    return { allowed: true };
  }

  const dmPolicy = account.config.dmPolicy ?? "open";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));

  // If dmPolicy is disabled, reject immediately
  if (dmPolicy === "disabled") {
    runtime.log?.(`[WeCom] Blocked DM from ${senderId} (dmPolicy=disabled)`);
    return { allowed: false };
  }

  // If open mode, allow everyone
  if (dmPolicy === "open") {
    return { allowed: true };
  }

  // OpenClaw <= 2026.2.19 signature: readAllowFromStore(channel, env?, accountId?)
  const oldStoreAllowFrom = await core.channel.pairing
    // @ts-expect-error — Compatibility with old SDK's three-argument signature; new version uses single object parameter
    .readAllowFromStore("wecom", undefined, account.accountId)
    .catch(() => []);
  // Compatibility fallback for newer OpenClaw implementations.
  const newStoreAllowFrom = await core.channel.pairing
    .readAllowFromStore({ channel: CHANNEL_ID, accountId: account.accountId })
    .catch(() => []);

  // Check if the sender is in the allow list
  const storeAllowFrom = [...oldStoreAllowFrom, ...newStoreAllowFrom];

  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const senderAllowedResult = isSenderAllowed(senderId, effectiveAllowFrom);

  if (senderAllowedResult) {
    return { allowed: true };
  }

  // Handle unauthorized users
  if (dmPolicy === "pairing") {
    const { code, created } = await core.channel.pairing.upsertPairingRequest({
      channel: CHANNEL_ID,
      id: senderId,
      accountId: account.accountId,
      meta: { name: senderId },
    });

    if (created) {
      runtime.log?.(`[WeCom] Pairing request created for sender=${senderId}`);
      try {
        await sendWeComReply({
          wsClient,
          frame,
          text: core.channel.pairing.buildPairingReply({
            channel: CHANNEL_ID,
            idLine: `您的企业微信用户ID: ${senderId}`,
            code,
          }),
          runtime,
          finish: true,
        });
      } catch (err) {
        runtime.error?.(`[WeCom] Failed to send pairing reply to ${senderId}: ${String(err)}`);
      }
    } else {
      runtime.log?.(`[WeCom] Pairing request already exists for sender=${senderId}`);
    }
    return { allowed: false, pairingSent: created };
  }

  // Allowlist mode: reject unauthorized users directly
  runtime.log?.(`[WeCom] Blocked unauthorized sender ${senderId} (dmPolicy=${dmPolicy})`);
  return { allowed: false };
}
