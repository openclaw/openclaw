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
  const state = states.get(sessionKey);
  if (!state) {
    return false; // No failures recorded — circuit is closed
  }
  const max = opts?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const now = opts?.nowMs ?? Date.now();

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

export function recordCompactionSuccess(sessionKey: string): void {
  const state = getState(sessionKey);
  if (state.consecutiveFailures > 0) {
    log.info(
      `[compaction-circuit-breaker] reset after success: sessionKey=${sessionKey} priorFailures=${state.consecutiveFailures}`,
    );
  }
  state.consecutiveFailures = 0;
  state.lastFailureAt = 0;
  state.cooldownUntil = 0;
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
};
