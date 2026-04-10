/**
 * Rate Limit Circuit Breaker Plugin for OpenClaw
 *
 * Prevents death loops in multi-agent group chats (Matrix, Discord, etc.)
 * where a rate-limit error surfaced by one agent triggers other agents to
 * respond, causing them to also hit rate limits in an infinite cascade.
 *
 * Mechanism:
 *   1. Hooks into `message_sending` to inspect every outgoing message
 *   2. Detects rate-limit/overload error messages by pattern matching
 *   3. Tracks consecutive rate-limit errors per room (channel + target)
 *   4. After N consecutive errors, opens the circuit breaker:
 *      - Suppresses further error messages for a cooldown period
 *      - Uses exponential backoff on repeated trips
 *   5. After cooldown, allows one retry (half-open state)
 *   6. On success (non-error message), fully resets the circuit
 */

import { RateLimitCircuitBreaker } from "./src/circuit-breaker.js";

// Singleton — shared across all hooks for the lifetime of the gateway process
let breaker: RateLimitCircuitBreaker | null = null;

// Periodic cleanup interval handle
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export default function register(api: any) {
  const pluginConfig = api.pluginConfig ?? {};
  const logger = api.logger ?? { warn: console.warn, debug: undefined };

  breaker = new RateLimitCircuitBreaker(
    {
      maxConsecutiveErrors: pluginConfig.maxConsecutiveErrors ?? 3,
      baseCooldownMs: pluginConfig.baseCooldownMs ?? 60_000,
      maxCooldownMs: pluginConfig.maxCooldownMs ?? 600_000,
    },
    {
      warn: (msg: string) => logger.warn(msg),
      debug: logger.debug ? (msg: string) => logger.debug!(msg) : undefined,
    },
  );

  // --- message_sending hook: intercept outgoing messages ---
  api.on(
    "message_sending",
    (
      event: { to: string; content: string; metadata?: Record<string, unknown> },
      ctx: { channelId: string; accountId?: string; conversationId?: string },
    ) => {
      if (!breaker || !event.content) return;

      const channelId = ctx.channelId ?? (event.metadata?.channel as string) ?? "unknown";
      const to = event.to ?? "";

      if (!to) return;

      const suppress = breaker.shouldSuppress(channelId, to, event.content);
      if (suppress) {
        return { cancel: true };
      }
      // Allow the message through (no modification)
      return undefined;
    },
    { priority: -100 }, // Run early so we can cancel before other hooks process
  );

  // --- gateway_start hook: set up periodic cleanup ---
  api.on("gateway_start", () => {
    // Clean up stale circuit breaker entries every 30 minutes
    cleanupInterval = setInterval(() => {
      breaker?.cleanup(3_600_000); // 1 hour max age
    }, 30 * 60 * 1000);
  });

  // --- gateway_stop hook: teardown ---
  api.on("gateway_stop", () => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  });

  // --- Register a gateway method for diagnostics ---
  api.registerGatewayMethod(
    "circuit-breaker-status",
    async (params: { channel?: string; to?: string }) => {
      if (!breaker) return { status: "not_initialized" };
      if (params.channel && params.to) {
        const state = breaker.getState(params.channel, params.to);
        return { room: `${params.channel}:${params.to}`, state: state ?? "no_data" };
      }
      return { status: "ok", message: "Pass channel and to params to query a specific room" };
    },
  );

  logger.warn("[rate-limit-circuit-breaker] Plugin registered");
}
