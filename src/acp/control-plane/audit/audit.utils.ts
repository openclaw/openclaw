/**
 * Audit logger utility functions.
 */

import { FileAuditLogger } from "./audit-logger.file.js";
import { createNullAuditLogger } from "./audit-logger.null.js";
import type { AuditActor, IAuditLogger } from "./audit.types.js";
import { AUDIT_EVENT_TYPES } from "./audit.types.js";

/**
 * Extract actor information from request context.
 *
 * This function extracts user, device, and client information from various
 * input types (config, request headers, etc.) for audit logging.
 *
 * @param ctx - Context containing actor information
 * @returns Actor information for audit log
 */
export function extractActor(ctx: {
  cfg?: unknown;
  userId?: string;
  deviceId?: string;
  clientIp?: string;
  userAgent?: string;
}): AuditActor {
  const actor: AuditActor = {};

  if (ctx.userId) {
    actor.userId = ctx.userId;
  }
  if (ctx.deviceId) {
    actor.deviceId = ctx.deviceId;
  }
  if (ctx.clientIp) {
    actor.clientIp = ctx.clientIp;
  }
  if (ctx.userAgent) {
    actor.userAgent = ctx.userAgent;
  }

  return actor;
}

/**
 * Extract agent ID from session key or input.
 *
 * @param sessionKey - Session key
 * @returns Agent ID
 */
export function extractAgentId(sessionKey: string): string {
  // Session key format: "agent:<agentId>:acp:<uuid>"
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match ? match[1] : "unknown";
}

/**
 * Create an audit logger based on configuration.
 *
 * @param enabled - Whether audit logging is enabled
 * @param config - Optional audit logger configuration
 * @returns An audit logger instance
 */
export function createAuditLogger(
  enabled: boolean,
  config?: {
    storageDir?: string;
    maxBufferSize?: number;
    flushInterval?: number;
    retentionDays?: number;
  },
): IAuditLogger {
  if (!enabled) {
    return createNullAuditLogger();
  }

  return new FileAuditLogger({
    enabled: true,
    ...config,
  });
}

/**
 * Re-export audit event types for convenience.
 */
export { AUDIT_EVENT_TYPES };
