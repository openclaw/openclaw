/**
 * ENGN-5610: Circuit breaker for subagent spawning.
 *
 * Tracks subagent spawn failures and trips the circuit when failures exceed
 * a threshold within a time window. While tripped, all spawning is paused
 * for a configurable cooldown period.
 */

import { defaultRuntime } from "../runtime.js";

export type CircuitBreakerConfig = {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
};

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 300_000; // 5 minutes
const DEFAULT_COOLDOWN_MS = 180_000; // 3 minutes

let config: CircuitBreakerConfig = {
  failureThreshold: DEFAULT_FAILURE_THRESHOLD,
  windowMs: DEFAULT_WINDOW_MS,
  cooldownMs: DEFAULT_COOLDOWN_MS,
};

let failures: number[] = [];
let trippedAt: number | null = null;

export function configureCircuitBreaker(partial: Partial<CircuitBreakerConfig>): void {
  if (typeof partial.failureThreshold === "number" && partial.failureThreshold >= 1) {
    config.failureThreshold = Math.floor(partial.failureThreshold);
  }
  if (typeof partial.windowMs === "number" && partial.windowMs > 0) {
    config.windowMs = Math.floor(partial.windowMs);
  }
  if (typeof partial.cooldownMs === "number" && partial.cooldownMs > 0) {
    config.cooldownMs = Math.floor(partial.cooldownMs);
  }
}

function pruneOldFailures(now: number): void {
  const cutoff = now - config.windowMs;
  failures = failures.filter((t) => t > cutoff);
}

export function recordSpawnFailure(error?: string): void {
  const now = Date.now();

  // Only count overload/rate-limit errors; undefined/empty = not relevant
  if (!error) {
    return;
  }
  const errorLower = error.toLowerCase();
  const isRelevant =
    errorLower.includes("overload") ||
    errorLower.includes("rate") ||
    errorLower.includes("429") ||
    errorLower.includes("503") ||
    errorLower.includes("too many");
  if (!isRelevant) {
    return;
  }

  pruneOldFailures(now);
  failures.push(now);

  if (failures.length >= config.failureThreshold && trippedAt === null) {
    trippedAt = now;
    defaultRuntime.log(
      `[circuit-breaker] TRIPPED — ${failures.length} failures in ${config.windowMs}ms window. ` +
        `Spawning paused for ${config.cooldownMs}ms.`,
    );
  }
}

export function isCircuitOpen(): boolean {
  if (trippedAt === null) {
    return false;
  }
  const now = Date.now();
  if (now - trippedAt >= config.cooldownMs) {
    defaultRuntime.log(`[circuit-breaker] RESET — cooldown of ${config.cooldownMs}ms elapsed.`);
    trippedAt = null;
    failures = [];
    return false;
  }
  return true;
}

export function getCircuitBreakerStatus(): {
  state: "closed" | "open";
  recentFailures: number;
  trippedAt: number | null;
  cooldownRemainingMs: number | null;
} {
  const now = Date.now();
  pruneOldFailures(now);
  const open = isCircuitOpen();
  return {
    state: open ? "open" : "closed",
    recentFailures: failures.length,
    trippedAt,
    cooldownRemainingMs:
      trippedAt !== null ? Math.max(0, config.cooldownMs - (now - trippedAt)) : null,
  };
}

export function getCircuitBreakerSpawnError(): string {
  const status = getCircuitBreakerStatus();
  const remainingSec = status.cooldownRemainingMs
    ? Math.ceil(status.cooldownRemainingMs / 1000)
    : 0;
  return (
    `Subagent spawning is temporarily paused due to repeated failures ` +
    `(${status.recentFailures} in the last ${Math.round(config.windowMs / 1000)}s). ` +
    `Retry in ~${remainingSec}s.`
  );
}

export function resetCircuitBreakerForTests(): void {
  failures = [];
  trippedAt = null;
  config = {
    failureThreshold: DEFAULT_FAILURE_THRESHOLD,
    windowMs: DEFAULT_WINDOW_MS,
    cooldownMs: DEFAULT_COOLDOWN_MS,
  };
}
