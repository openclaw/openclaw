/**
 * Audit log system for OpenClaw control plane.
 *
 * @module audit
 */

// Types
export type {
  AuditActor,
  AuditEventType,
  AuditLogEntry,
  AuditLogFilters,
  AuditLoggerConfig,
  AuditLogStats,
  IAuditLogger,
} from "./audit.types.js";

export { AUDIT_EVENT_TYPES, DEFAULT_AUDIT_CONFIG } from "./audit.types.js";

// Logger implementations
export { FileAuditLogger } from "./audit-logger.file.js";
export { NullAuditLogger, NULL_AUDIT_LOGGER, createNullAuditLogger } from "./audit-logger.null.js";

// Utilities
export { createAuditLogger, extractActor, extractAgentId } from "./audit.utils.js";
