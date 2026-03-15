/**
 * Shared utilities for spawn operations across different runtimes.
 * This module consolidates common patterns from acp-spawn, subagent-spawn, and claude-code-spawn.
 */

import type { DeliveryContext } from "../utils/delivery-context.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";

// ============================================================================
// Spawn Mode Types
// ============================================================================

/**
 * Common spawn modes shared by all runtime types.
 * - "run": One-shot execution that cleans up after completion.
 * - "session": Persistent session that remains active for follow-ups.
 */
export const SPAWN_MODES = ["run", "session"] as const;
export type SpawnMode = (typeof SPAWN_MODES)[number];

// ============================================================================
// Shared Context Types
// ============================================================================

/**
 * Base context provided by the requester session when spawning a child.
 * Used to track the origin of spawn requests and enable result delivery.
 */
export type SpawnBaseContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  sandboxed?: boolean;
};

/**
 * Base result type returned by all spawn functions.
 */
export type SpawnBaseResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnMode;
  note?: string;
  error?: string;
};

// ============================================================================
// Spawn Mode Resolution
// ============================================================================

/**
 * Resolve the effective spawn mode based on request parameters.
 *
 * Priority:
 * 1. Explicit mode request ("run" or "session")
 * 2. Thread/resume preference defaults to "session"
 * 3. Default to "run" for one-shot execution
 */
export function resolveSpawnMode(params: {
  requestedMode?: SpawnMode;
  threadRequested?: boolean;
  resumeRequested?: boolean;
}): SpawnMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound or resume spawns should default to persistent sessions.
  const wantsPersistence = params.threadRequested === true || params.resumeRequested === true;
  return wantsPersistence ? "session" : "run";
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Convert an unknown error value to a user-friendly string.
 * Used consistently across spawn operations for error reporting.
 */
export function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

// ============================================================================
// Delivery Context Helpers
// ============================================================================

/**
 * Extract a normalized delivery context from spawn context.
 * This consolidates the common pattern of extracting requester origin.
 */
export function extractRequesterOrigin(ctx: SpawnBaseContext): DeliveryContext | undefined {
  return normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });
}
