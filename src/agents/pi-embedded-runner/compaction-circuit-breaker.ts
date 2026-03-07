import { resolveProcessScopedMap } from "../../shared/process-scoped-map.js";
import { log } from "./logger.js";

const CIRCUIT_BREAKER_KEY = Symbol.for("openclaw.compactionCircuitBreaker");

type CircuitState = {
  consecutiveFailures: number;
  lastFailureAt: number;
  cooldownUntil: number;
};

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
// Evict stale entries 1 hour after their cooldown expires to prevent unbounded map growth.
const EVICTION_GRACE_MS = 60 * 60 * 1000; // 1 hour

const states = resolveProcessScopedMap<CircuitState>(CIRCUIT_BREAKER_KEY);

function getState(sessionKey: string): CircuitState {
  const existing = states.get(sessionKey);
  if (existing) {
    return existing;
  }
  const created: CircuitState = {
    consecutiveFailures: 0,
    lastFailureAt: 0,
    cooldownUntil: 0,
  };
  states.set(sessionKey, created);
  return created;
}

export function isCompactionCircuitOpen(
  sessionKey: string,
  opts?: { maxConsecutiveFailures?: number; nowMs?: number },
): boolean {
  const now = opts?.nowMs ?? Date.now();
  // Lazily evict stale entries to prevent unbounded map growth in long-lived processes.
  evictStaleEntries(now);

  const state = states.get(sessionKey);
  if (!state) {
    return false; // No failures recorded — circuit is closed
  }
  const max = opts?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

  if (state.consecutiveFailures < max) {
    return false;
  }
  // Still in cooldown?
  if (now < state.cooldownUntil) {
    return true;
  }
  // Cooldown expired — half-open: allow one attempt
  return false;
}

let lastEvictionAt = 0;
function evictStaleEntries(now: number): void {
  // Run at most once per eviction grace period to avoid per-call iteration cost.
  if (now - lastEvictionAt < EVICTION_GRACE_MS) {
    return;
  }
  lastEvictionAt = now;
  for (const [key, state] of states) {
    if (state.cooldownUntil > 0 && now > state.cooldownUntil + EVICTION_GRACE_MS) {
      states.delete(key);
    }
  }
}

export function recordCompactionSuccess(sessionKey: string): void {
  const existing = states.get(sessionKey);
  if (existing && existing.consecutiveFailures > 0) {
    log.info(
      `[compaction-circuit-breaker] reset after success: sessionKey=${sessionKey} priorFailures=${existing.consecutiveFailures}`,
    );
  }
  // Successful sessions don't need state — delete to prevent unbounded map growth.
  states.delete(sessionKey);
}

export function recordCompactionFailure(
  sessionKey: string,
  opts?: { cooldownMs?: number; nowMs?: number },
): void {
  const state = getState(sessionKey);
  const now = opts?.nowMs ?? Date.now();
  const cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  // Exponential backoff: cooldown doubles each consecutive failure, capped at 30 min
  const backoffMs = Math.min(
    cooldownMs * Math.pow(2, state.consecutiveFailures - 1),
    30 * 60 * 1000,
  );
  state.cooldownUntil = now + backoffMs;

  log.warn(
    `[compaction-circuit-breaker] failure recorded: sessionKey=${sessionKey} ` +
      `consecutiveFailures=${state.consecutiveFailures} cooldownMs=${backoffMs}`,
  );
}

export function getCompactionCircuitState(sessionKey: string): Readonly<CircuitState> {
  return getState(sessionKey);
}

export function resetCompactionCircuit(sessionKey: string): void {
  states.delete(sessionKey);
}

export const __testing = {
  states,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_COOLDOWN_MS,
  EVICTION_GRACE_MS,
  resetLastEvictionAt: () => {
    lastEvictionAt = 0;
  },
};
