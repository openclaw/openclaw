/**
 * Null audit logger implementation (Null Object pattern).
 *
 * Used when audit logging is disabled or for testing.
 * All methods are no-ops to avoid conditional checks in calling code.
 */

import type {
  AuditLogEntry,
  AuditLogFilters,
  AuditLogStats,
  IAuditLogger,
} from "./audit.types.js";

/**
 * Null audit logger - no-op implementation.
 */
export class NullAuditLogger implements IAuditLogger {
  /** @inheritdoc */
  async log(_entry: Omit<AuditLogEntry, "id" | "timestamp">): Promise<void> {
    // No-op
  }

  /** @inheritdoc */
  async query(_filters: AuditLogFilters): Promise<AuditLogEntry[]> {
    return [];
  }

  /** @inheritdoc */
  async flush(): Promise<void> {
    // No-op
  }

  /** @inheritdoc */
  async getStats(): Promise<AuditLogStats> {
    return {
      totalEntries: 0,
      entriesByAction: {},
      entriesByResult: {
        success: 0,
        failure: 0,
      },
    };
  }

  /** @inheritdoc */
  async prune(_before: number): Promise<number> {
    return 0;
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    // No-op
  }
}

/**
 * Singleton instance of NullAuditLogger.
 */
export const NULL_AUDIT_LOGGER = new NullAuditLogger();

/**
 * Create a null audit logger.
 * @returns A null audit logger instance
 */
export function createNullAuditLogger(): IAuditLogger {
  return NULL_AUDIT_LOGGER;
}
