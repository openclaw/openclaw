/**
 * UID 解析与绑定
 *
 * 优先级链：
 * 1. 钉钉 userId（通过 connector 的 device-auth 获取）
 * 2. 本机 fingerprint（兜底，基于 hostname + username 的 SHA256）
 */

import { createHash } from 'crypto';
import * as os from 'os';

const SALT = 'xiyou-salt-2026';

/**
 * 根据原始 UID 生成稳定的哈希标识
 */
export function hashUid(rawUid: string): string {
  return createHash('sha256')
    .update(rawUid + SALT)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 生成本机指纹作为兜底 UID
 */
function generateMachineFingerprint(): string {
  const hostname = os.hostname();
  const username = os.userInfo().username;
  return `machine:${hostname}:${username}`;
}

/**
 * 解析用户 UID
 *
 * @param senderId - 钉钉消息的发送者 ID（优先使用）
 * @returns 稳定的 UID 哈希值（16 位 hex）
 */
export function resolveUid(senderId?: string): string {
  const rawUid = senderId || generateMachineFingerprint();
  return hashUid(rawUid);
}

/**
 * 获取 UID 的短标识（用于展示）
 */
export function getShortUid(uidHash: string): string {
  return uidHash.slice(0, 8);
}
