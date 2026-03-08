/**
 * 企业微信 DM（私聊）访问控制模块
 *
 * 负责私聊策略检查、配对流程
 */

import type { WSClient, WsFrame } from "@wecom/aibot-node-sdk";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { CHANNEL_ID } from "./const.ts";
import { isSenderAllowed } from "./group-policy.ts";
import { sendWeComReply } from "./message-sender.ts";
import { getWeComRuntime } from "./runtime.ts";
import type { ResolvedWeComAccount } from "./utils.ts";

// ============================================================================
// 检查结果类型
// ============================================================================

/**
 * DM Policy 检查结果
 */
export interface DmPolicyCheckResult {
  /** 是否允许继续处理消息 */
  allowed: boolean;
  /** 是否已发送配对消息（仅在 pairing 模式下） */
  pairingSent?: boolean;
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 检查 DM Policy 访问控制
 * @returns 检查结果，包含是否允许继续处理
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

  // 群聊消息不检查 DM Policy
  if (isGroup) {
    return { allowed: true };
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));

  // 如果 dmPolicy 是 disabled，直接拒绝
  if (dmPolicy === "disabled") {
    runtime.log?.(`[WeCom] Blocked DM from ${senderId} (dmPolicy=disabled)`);
    return { allowed: false };
  }

  // 如果是 open 模式，允许所有人
  if (dmPolicy === "open") {
    return { allowed: true };
  }

  // 检查发送者是否在允许列表中
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore({ channel: CHANNEL_ID, accountId: account.accountId })
    .catch(() => []);
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const senderAllowedResult = isSenderAllowed(senderId, effectiveAllowFrom);

  if (senderAllowedResult) {
    return { allowed: true };
  }

  // 处理未授权用户
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

  // allowlist 模式：直接拒绝未授权用户
  runtime.log?.(`[WeCom] Blocked unauthorized sender ${senderId} (dmPolicy=${dmPolicy})`);
  return { allowed: false };
}
