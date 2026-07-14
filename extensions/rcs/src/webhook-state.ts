import { createFixedWindowRateLimiter } from "openclaw/plugin-sdk/webhook-ingress";

const INBOUND_IP_RATE_LIMIT_PER_MINUTE = 600;
const INBOUND_SENDER_RATE_LIMIT_PER_MINUTE = 30;
export type RcsWebhookRateLimiter = ReturnType<typeof createFixedWindowRateLimiter>;

export function createInboundIpRateLimiter(): RcsWebhookRateLimiter {
  return createFixedWindowRateLimiter({
    maxRequests: INBOUND_IP_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    maxTrackedKeys: 5_000,
  });
}

export function createInboundSenderRateLimiter(): RcsWebhookRateLimiter {
  return createFixedWindowRateLimiter({
    maxRequests: INBOUND_SENDER_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    maxTrackedKeys: 10_000,
  });
}

export function createStatusRateLimiter(): RcsWebhookRateLimiter {
  return createFixedWindowRateLimiter({
    maxRequests: 120,
    windowMs: 60_000,
    maxTrackedKeys: 5_000,
  });
}
