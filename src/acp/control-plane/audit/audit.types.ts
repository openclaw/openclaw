/**
 * Audit log system for OpenClaw control plane.
 *
 * Provides comprehensive audit logging for security, compliance, and debugging.
 *
 * @module audit
 */

/**
 * Audit event types - all operations that should be logged.
 */
export const AUDIT_EVENT_TYPES = {
  // Session lifecycle events
  SESSION_INIT: "session_init",
  SESSION_CLOSE: "session_close",
  SESSION_CANCEL: "session_cancel",

  // Runtime control events
  RUNTIME_MODE_SET: "runtime_mode_set",
  RUNTIME_OPTIONS_SET: "runtime_options_set",

  // Execution events
  TURN_START: "turn_start",
  TURN_COMPLETE: "turn_complete",
  TURN_FAILED: "turn_failed",

  // Error events
  ERROR: "error",
} as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[keyof typeof AUDIT_EVENT_TYPES];

/**
 * Actor information - who performed the action.
 */
export type AuditActor = {
  userId?: string;
  deviceId?: string;
  clientIp?: string;
  userAgent?: string;
};

/**
 * Audit log entry - a single record of an action.
 */
export type AuditLogEntry = {
  // Basic information
  id: string;
  timestamp: number;

  // Actor information
  actor: AuditActor;

  // Action information
  action: AuditEventType;
  sessionKey: string;
  agentId: string;

  // Detailed information
  details: {
    [key: string]: unknown;
  };

  // Result
  result: "success" | "failure";
  error?: {
    code: string;
    message: string;
  };

  // Performance metrics
  duration?: number;
};

/**
 * Query filters for searching audit logs.
 */
export type AuditLogFilters = {
  startTime?: number;
  endTime?: number;
  userId?: string;
  deviceId?: string;
  sessionKey?: string;
  agentId?: string;
  action?: AuditEventType;
  result?: "success" | "failure";
  limit?: number;
};

/**
 * Audit log statistics.
 */
export type AuditLogStats = {
  totalEntries: number;
  entriesByAction: Record<string, number>;
  entriesByResult: {
    success: number;
    failure: number;
  };
  oldestEntry?: number;
  newestEntry?: number;
};

/**
 * Audit logger configuration.
 */
export type AuditLoggerConfig = {
  enabled?: boolean;
  maxBufferSize?: number;
  flushInterval?: number;
  retentionDays?: number;
  storageDir?: string;
  compress?: boolean;
};

/**
 * Audit logger interface.
 */
export interface IAuditLogger {
  /**
   * Log an audit event.
   * @param entry - The audit entry to log (without id and timestamp)
   */
  log(entry: Omit<AuditLogEntry, "id" | "timestamp">): Promise<void>;

  /**
   * Query audit logs.
   * @param filters - Query filters
   * @returns Array of matching log entries
   */
  query(filters: AuditLogFilters): Promise<AuditLogEntry[]>;

  /**
   * Flush buffered logs to disk.
   */
  flush(): Promise<void>;

  /**
   * Get audit log statistics.
   */
  getStats(): Promise<AuditLogStats>;

  /**
   * Prune old log entries.
   * @param before - Timestamp before which to prune
   * @returns Number of entries pruned
   */
  prune(before: number): Promise<number>;

  /**
   * Close the audit logger and flush remaining logs.
   */
  close(): Promise<void>;
}

/**
 * Default audit logger configuration.
 */
export const DEFAULT_AUDIT_CONFIG: Required<AuditLoggerConfig> = {
  enabled: false,
  maxBufferSize: 1000,
  flushInterval: 30000, // 30 seconds
  retentionDays: 90,
  storageDir: ".audit",
  compress: true,
};
