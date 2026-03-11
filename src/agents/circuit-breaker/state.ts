import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OutboundSendDeps } from "../../infra/outbound/deliver.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { CircuitBreakerAction, CircuitBreakerConfig } from "./types.js";

const log = createSubsystemLogger("circuit-breaker");

const DEFAULT_CONSECUTIVE_ERRORS = 5;
const DEFAULT_COOLDOWN_MINUTES = 30;

/** Resolve the action list from config, normalizing single string to array. */
function resolveActions(config: CircuitBreakerConfig): CircuitBreakerAction[] {
  const raw = config.action;
  if (!raw) {
    return [];
  }
  return Array.isArray(raw) ? raw : [raw];
}

/** Resolve the consecutive error threshold from config. */
function resolveThreshold(config: CircuitBreakerConfig | undefined): number {
  return config?.consecutiveErrors ?? DEFAULT_CONSECUTIVE_ERRORS;
}

/**
 * Check if a session's circuit breaker is currently tripped (open state).
 *
 * Returns true when the session should be skipped.
 * Returns false when the session can attempt a run (closed or half-open).
 */
export function isCircuitBreakerTripped(
  entry: SessionEntry,
  config: CircuitBreakerConfig | undefined,
  now?: number,
): boolean {
  if (!config) {
    return false;
  }
  if (typeof entry.cbTrippedAt !== "number") {
    return false;
  }

  // If cooldownUntil is set, check if it has expired (half-open).
  if (typeof entry.cbCooldownUntil === "number") {
    const currentTime = now ?? Date.now();
    if (currentTime >= entry.cbCooldownUntil) {
      // Cooldown expired — allow a probe attempt (half-open).
      return false;
    }
    // Still in cooldown.
    return true;
  }

  // Tripped without cooldown means a reset action should have cleared it,
  // or alert-only which doesn't block. For alert-only, tripped state is
  // cleared immediately after executing actions.
  const actions = resolveActions(config);
  const hasPause = actions.includes("pause");
  if (!hasPause) {
    // Alert-only or reset (reset clears state). Not blocking.
    return false;
  }

  // Pause without cooldownUntil is a logic error; treat as not tripped.
  return false;
}

/**
 * Record a model-level error on the session.
 * Returns `{ tripped: true }` when the error count reaches the threshold.
 */
export function recordCircuitBreakerError(
  entry: SessionEntry,
  config: CircuitBreakerConfig | undefined,
  reason: string,
  now?: number,
): { tripped: boolean } {
  if (!config) {
    return { tripped: false };
  }

  const currentTime = now ?? Date.now();
  const prevCount = entry.cbErrorCount ?? 0;
  const nextCount = prevCount + 1;
  entry.cbErrorCount = nextCount;
  entry.cbLastErrorAt = currentTime;
  entry.cbLastErrorReason = reason;

  const threshold = resolveThreshold(config);
  if (nextCount >= threshold) {
    entry.cbTrippedAt = currentTime;
    log.warn(
      `Circuit breaker tripped: ${nextCount} consecutive errors (threshold: ${threshold}, reason: ${reason})`,
    );
    return { tripped: true };
  }
  return { tripped: false };
}

/**
 * Clear all circuit breaker state on a successful run.
 * Called after a model call succeeds — resets the session to closed state.
 * Returns `true` when any cb field was actually present (state changed).
 */
export function clearCircuitBreakerErrors(entry: SessionEntry): boolean {
  const had =
    entry.cbErrorCount !== undefined ||
    entry.cbTrippedAt !== undefined ||
    entry.cbCooldownUntil !== undefined;
  delete entry.cbErrorCount;
  delete entry.cbLastErrorAt;
  delete entry.cbLastErrorReason;
  delete entry.cbTrippedAt;
  delete entry.cbCooldownUntil;
  return had;
}

/**
 * Reset session fields to start a fresh session (equivalent to `/new`).
 * Only touches fields that need clearing for a new session context.
 */
function resetSession(entry: SessionEntry): void {
  entry.sessionId = crypto.randomUUID();
  delete entry.sessionFile;
  entry.systemSent = false;
  delete entry.compactionCount;
  delete entry.totalTokens;
  delete entry.totalTokensFresh;
  delete entry.inputTokens;
  delete entry.outputTokens;
  delete entry.cacheRead;
  delete entry.cacheWrite;
  delete entry.memoryFlushAt;
  delete entry.memoryFlushCompactionCount;
  delete entry.skillsSnapshot;
  delete entry.systemPromptReport;
  // Clear circuit breaker state — fresh session starts clean.
  clearCircuitBreakerErrors(entry);
}

/**
 * Execute the configured circuit breaker actions in order.
 * - alert: deliver a notification to the configured channel
 * - reset: start a fresh session (equivalent to /new)
 * - pause: set cooldown timer; subsequent runs are skipped until expiry
 *
 * When both reset and pause are configured, reset takes priority (pause is a no-op
 * after reset since the session starts fresh).
 */
export async function executeCircuitBreakerActions(params: {
  entry: SessionEntry;
  config: CircuitBreakerConfig;
  sessionKey: string;
  agentId: string;
  cfg: OpenClawConfig;
  deps?: OutboundSendDeps;
  now?: number;
}): Promise<void> {
  const { entry, config, sessionKey, agentId, cfg } = params;
  const currentTime = params.now ?? Date.now();
  const actions = resolveActions(config);
  let didReset = false;

  for (const action of actions) {
    switch (action) {
      case "alert": {
        const channel = config.alertChannel?.trim();
        const to = config.alertTo?.trim();
        if (!channel || !to) {
          log.warn(
            `Circuit breaker alert skipped: missing alertChannel or alertTo (session: ${sessionKey})`,
          );
          break;
        }
        const message = [
          "Circuit breaker tripped",
          `Agent: ${agentId}`,
          `Session: ${sessionKey}`,
          `Consecutive errors: ${entry.cbErrorCount ?? 0}`,
          `Last error: ${entry.cbLastErrorReason ?? "unknown"}`,
        ].join("\n");
        try {
          const session = buildOutboundSessionContext({ cfg, agentId, sessionKey });
          await deliverOutboundPayloads({
            cfg,
            channel,
            to,
            accountId: config.alertAccountId,
            payloads: [{ text: message }],
            session,
            deps: params.deps,
          });
          log.info(`Circuit breaker alert sent to ${channel}:${to} (session: ${sessionKey})`);
        } catch (err) {
          log.error(
            `Circuit breaker alert delivery failed (session: ${sessionKey}): ${String(err)}`,
          );
        }
        break;
      }
      case "reset": {
        resetSession(entry);
        didReset = true;
        log.info(`Circuit breaker reset session (session: ${sessionKey})`);
        break;
      }
      case "pause": {
        // Skip pause if reset already happened — fresh session doesn't need pausing.
        if (didReset) {
          break;
        }
        const cooldownMs = (config.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60_000;
        entry.cbCooldownUntil = currentTime + cooldownMs;
        log.info(
          `Circuit breaker paused session for ${config.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES}m (session: ${sessionKey})`,
        );
        break;
      }
    }
  }

  // If actions are alert-only (no pause, no reset), clear the tripped state
  // so the session is not permanently stuck.
  if (!didReset && !actions.includes("pause")) {
    delete entry.cbTrippedAt;
  }
}
