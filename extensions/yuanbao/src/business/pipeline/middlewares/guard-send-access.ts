/**
 * Middleware: send access control guard.
 *
 * Prevents abuse by controlling who can trigger sends and enforcing rate limits.
 * Only applies to C2C (direct message) scenarios; group chat is skipped.
 */

import type { MiddlewareDescriptor } from "../types.js";

interface SendAccessPolicy {
  /** Who can trigger messages sent through the bot */
  allowedSenders: "all" | "admin" | "allowlist";
  /** Allowed sender ID list (effective when allowedSenders = "allowlist") */
  senderAllowlist?: string[];
  /** Max sends per user per hour */
  rateLimitPerHour: number;
  /** Max message length (characters) */
  maxMessageLength: number;
}

/** Rate limit tracking: senderId -> recent send timestamps */
const rateLimitMap = new Map<string, number[]>();

/** Rate window: 1 hour */
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** Cleanup counter: clean expired entries every 100 checks */
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

  // Remove entries outside the rate window
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

const DEFAULT_SEND_ACCESS_POLICY: SendAccessPolicy = {
  allowedSenders: "all",
  senderAllowlist: [],
  rateLimitPerHour: 60,
  maxMessageLength: 4000,
};

/**
 * Send access control guard middleware.
 *
 * Checks: self-send protection, sender authorization, message length, rate limit.
 * Only applies to C2C (direct message) scenarios.
 */
export const guardSendAccess: MiddlewareDescriptor = {
  name: "guard-send-access",
  when: (ctx) => !ctx.isGroup,
  handler: async (ctx, next) => {
    const policy: SendAccessPolicy = DEFAULT_SEND_ACCESS_POLICY;
    const senderId = ctx.fromAccount;
    const targetId = ctx.account.botId ?? ctx.account.accountId;
    const messageLength = ctx.rawBody.length;

    // 1. Self-send protection
    if (senderId === targetId) {
      ctx.log.info("[guard-send-access] send access denied: cannot send direct message to self");
      return;
    }

    // 2. Sender authorization
    if (policy.allowedSenders === "allowlist") {
      if (!policy.senderAllowlist?.includes(senderId)) {
        ctx.log.info(
          `[guard-send-access] send access denied: sender ${senderId} not in allow list`,
        );
        return;
      }
    }

    // 3. Message length check
    if (messageLength > policy.maxMessageLength) {
      ctx.log.info(
        `[guard-send-access] send access denied: message too long (${messageLength} chars), max ${policy.maxMessageLength}`,
      );
      return;
    }

    // 4. Rate limit
    if (isRateLimited(senderId, policy.rateLimitPerHour)) {
      ctx.log.error("[guard-send-access] send access denied: rate limit triggered", {
        senderId,
        rateLimitPerHour: policy.rateLimitPerHour,
      });
      return;
    }

    // All checks passed; record send and continue pipeline
    recordSend(senderId);
    await next();
  },
};
