/**
 * Middleware: send access control guard
 *
 * Enforce authorization and rate-limiting policies for sending direct messages through the bot.
 * 通过控制谁可以触发发送以及发送频率来防止滥用。
 * 仅对 C2C（私信）场景生效，群聊场景跳过。
 */

import type { MiddlewareDescriptor } from "../types.js";

// ============ 类型定义 ============

interface SendAccessPolicy {
  /** 谁可以触发通过机器人发送的消息 */
  allowedSenders: "all" | "admin" | "allowlist";
  /** 允许的发送者 ID 列表（当 allowedSenders = "allowlist" 时生效） */
  senderAllowlist?: string[];
  /** 每个用户每小时最大发送次数 */
  rateLimitPerHour: number;
  /** 最大消息长度（字符数） */
  maxMessageLength: number;
}

// ============ 频率限制器 ============

/** 频率限制追踪：senderId → 近期发送时间戳数组 */
const rateLimitMap = new Map<string, number[]>();

/** 频率窗口：1 小时 */
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** 清理计数器，每 100 次检查时清理过期条目 */
let cleanupCounter = 0;
const CLEANUP_INTERVAL = 100;

/**
 * Periodically clean up expired rate limit entries to prevent memory leaks
 */
function maybeCleanupExpiredEntries(): void {
  if (++cleanupCounter % CLEANUP_INTERVAL !== 0) {
    return;
  }
  const now = Date.now();
  for (const [key, timestamps] of rateLimitMap) {
    const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length === 0) {
      rateLimitMap.delete(key);
    } else {
      rateLimitMap.set(key, recent);
    }
  }
}

/**
 * Check whether the sender has exceeded the rate limit.
 */
function isRateLimited(senderId: string, maxPerHour: number): boolean {
  if (maxPerHour <= 0) {
    return true;
  }

  const now = Date.now();
  const timestamps = rateLimitMap.get(senderId) ?? [];

  // 移除超出频率窗口的旧条目
  const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
  rateLimitMap.set(senderId, recent);

  return recent.length >= maxPerHour;
}

/**
 * Record a send event for rate limiting.
 */
function recordSend(senderId: string): void {
  const timestamps = rateLimitMap.get(senderId) ?? [];
  timestamps.push(Date.now());
  rateLimitMap.set(senderId, timestamps);
  maybeCleanupExpiredEntries();
}

/**
 * Clear rate limit state (for testing only)
 */
export function clearRateLimits(): void {
  rateLimitMap.clear();
  cleanupCounter = 0;
}

// ============ Default策略 ============

const DEFAULT_SEND_ACCESS_POLICY: SendAccessPolicy = {
  allowedSenders: "all",
  senderAllowlist: [],
  rateLimitPerHour: 60,
  maxMessageLength: 4000,
};

// ============ 中间件 ============

/**
 * Send access control guard middleware
 *
 * Check items:
 * 1. 自发防护（不能通过机器人给自己发私信）
 * 2. 发送者授权（all / admin / allowlist）
 * 3. 消息长度
 * 4. 频率限制
 *
 * 仅对 C2C（私信）场景生效。
 */
export const guardSendAccess: MiddlewareDescriptor = {
  name: "guard-send-access",
  when: (ctx) => !ctx.isGroup,
  handler: async (ctx, next) => {
    const policy: SendAccessPolicy = DEFAULT_SEND_ACCESS_POLICY;
    const senderId = ctx.fromAccount;
    const targetId = ctx.account.botId ?? ctx.account.accountId;
    const messageLength = ctx.rawBody.length;

    // 1. 自发防护
    if (senderId === targetId) {
      ctx.log.info("[guard-send-access] send access denied: cannot send direct message to self");
      return;
    }

    // 2. 发送者授权
    if (policy.allowedSenders === "allowlist") {
      if (!policy.senderAllowlist?.includes(senderId)) {
        ctx.log.info(
          `[guard-send-access] send access denied: sender ${senderId} not in allow list`,
        );
        return;
      }
    }

    // 3. 消息长度检查
    if (messageLength > policy.maxMessageLength) {
      ctx.log.info(
        `[guard-send-access] send access denied: message too long (${messageLength} chars), max ${policy.maxMessageLength}`,
      );
      return;
    }

    // 4. 频率限制
    if (isRateLimited(senderId, policy.rateLimitPerHour)) {
      ctx.log.error("[guard-send-access] send access denied: rate limit triggered", {
        senderId,
        rateLimitPerHour: policy.rateLimitPerHour,
      });
      return;
    }

    // 通过所有检查，记录发送并继续管线
    recordSend(senderId);
    await next();
  },
};
