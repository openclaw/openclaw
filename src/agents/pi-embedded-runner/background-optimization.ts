import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveBackgroundOptimization,
  type ResolvedBackgroundOptimization,
} from "../pi-settings.js";
import { log } from "./logger.js";

/**
 * Background memory optimization — proactively triggers compaction
 * before context hits emergency thresholds.
 *
 * This module tracks per-session state and determines WHEN to optimize.
 * The actual summarization is delegated to compactEmbeddedPiSessionDirect
 * which reuses the full compaction-safeguard pipeline.
 */

type SessionOptState = {
  /** Timestamp of the last background optimization. */
  lastOptimizedAt: number;
  /** User turn count at the time of last optimization. */
  turnsAtLastOptimize: number;
};

const SESSION_STATE = new Map<string, SessionOptState>();

/** Count user turns in a message array. */
function countUserTurns(messages: readonly AgentMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      count++;
    }
  }
  return count;
}

export type BackgroundOptimizationCheck = {
  shouldOptimize: boolean;
  reason?: string;
  userTurns: number;
  config: ResolvedBackgroundOptimization;
};

/**
 * Check whether a session needs background optimization.
 *
 * Triggers when BOTH:
 * 1. At least `optimizeAfterTurns` new user turns since last optimization
 * 2. At least `optimizeIntervalMin` minutes since last optimization
 *
 * AND the total user turns exceed `verbatimTurns` (otherwise there's nothing to summarize).
 */
export function checkBackgroundOptimization(
  sessionId: string,
  messages: readonly AgentMessage[],
  cfg?: OpenClawConfig,
): BackgroundOptimizationCheck {
  const config = resolveBackgroundOptimization(cfg);
  const userTurns = countUserTurns(messages);
  const noResult: BackgroundOptimizationCheck = { shouldOptimize: false, userTurns, config };

  // Nothing to summarize if total turns are within verbatim window
  if (userTurns <= config.verbatimTurns) {
    return noResult;
  }

  const state = SESSION_STATE.get(sessionId);
  const now = Date.now();

  if (!state) {
    // First check for this session — only optimize if we have significant history
    if (userTurns > config.verbatimTurns + config.optimizeAfterTurns) {
      return {
        shouldOptimize: true,
        reason: `first check: ${userTurns} turns exceed verbatim(${config.verbatimTurns}) + trigger(${config.optimizeAfterTurns})`,
        userTurns,
        config,
      };
    }
    return noResult;
  }

  const turnsSinceLast = userTurns - state.turnsAtLastOptimize;
  const msSinceLast = now - state.lastOptimizedAt;
  const minIntervalMs = config.optimizeIntervalMin * 60_000;

  if (turnsSinceLast < config.optimizeAfterTurns) {
    return noResult;
  }
  if (msSinceLast < minIntervalMs) {
    return noResult;
  }

  return {
    shouldOptimize: true,
    reason: `${turnsSinceLast} new turns, ${Math.round(msSinceLast / 60_000)}min since last`,
    userTurns,
    config,
  };
}

/** Record that a background optimization was performed (or started). */
export function markOptimizationDone(sessionId: string, userTurns: number): void {
  SESSION_STATE.set(sessionId, {
    lastOptimizedAt: Date.now(),
    turnsAtLastOptimize: userTurns,
  });
}

/** Clear tracked state for a session (e.g., on session reset). */
export function clearOptimizationState(sessionId: string): void {
  SESSION_STATE.delete(sessionId);
}

/**
 * Fire-and-forget background optimization after a successful run.
 *
 * This is the main entry point called from run.ts. It checks thresholds
 * and, if needed, triggers compaction via the provided callback.
 */
export function maybeScheduleBackgroundOptimization(params: {
  sessionId: string;
  messages: readonly AgentMessage[];
  cfg?: OpenClawConfig;
  triggerCompaction: () => Promise<{ compacted: boolean; reason?: string }>;
}): void {
  const check = checkBackgroundOptimization(params.sessionId, params.messages, params.cfg);

  if (!check.shouldOptimize) {
    return;
  }

  log.info(`[bg-optimize] scheduling for session=${params.sessionId}: ${check.reason}`);

  // Mark optimized immediately to prevent concurrent triggers
  markOptimizationDone(params.sessionId, check.userTurns);

  // Fire and forget — never blocks the reply
  params.triggerCompaction().then(
    (result) => {
      if (result.compacted) {
        log.info(`[bg-optimize] completed for session=${params.sessionId}`);
      } else {
        log.debug(
          `[bg-optimize] skipped for session=${params.sessionId}: ${result.reason ?? "nothing to compact"}`,
        );
      }
    },
    (err) => {
      log.warn(
        `[bg-optimize] failed for session=${params.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );
}

export const __testing = {
  SESSION_STATE,
  countUserTurns,
} as const;
