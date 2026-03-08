import { promises as fs } from "node:fs";
import { join } from "node:path";

// Audit Logger for VRChat OSC Operations
// Tracks all operations for safety and debugging

export type LogLevel = "INFO" | "SKIP" | "ERROR" | "WARN";

export interface AuditLogEntry {
  timestamp: string;
  level: LogLevel;
  operation: string;
  details: Record<string, unknown>;
  permissionLevel?: string;
  rateLimitStatus?: {
    allowed: boolean;
    remaining?: number;
    jailTimeRemaining?: number;
  };
}

// In-memory log buffer
const logBuffer: AuditLogEntry[] = [];
const MAX_BUFFER_SIZE = 1000;

/**
 * Log an operation
 */
export function auditLog(
  level: LogLevel,
  operation: string,
  details: Record<string, unknown> = {},
  extra?: {
    permissionLevel?: string;
    rateLimitStatus?: {
      allowed: boolean;
      remaining?: number;
      jailTimeRemaining?: number;
    };
  },
): void {
  const entry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    operation,
    details: sanitizeLogDetails(details),
    ...extra,
  };

  // Add to buffer
  logBuffer.push(entry);

  // Trim buffer if too large
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }

  // Console output
  const prefix = `[AUDIT ${level}]`;
  const message =
    extra?.rateLimitStatus?.allowed === false
      ? `${prefix} BLOCKED: ${operation}`
      : `${prefix} ${operation}`;

  console.log(message);
}

/**
 * Log a successful operation
 */
export function logInfo(operation: string, details?: Record<string, unknown>): void {
  auditLog("INFO", operation, details);
}

/**
 * Log a skipped operation (e.g., parameter not supported)
 */
export function logSkip(
  operation: string,
  reason: string,
  details?: Record<string, unknown>,
): void {
  auditLog("SKIP", operation, { reason, ...details });
}

/**
 * Log an error
 */
export function logError(
  operation: string,
  error: string | Error,
  details?: Record<string, unknown>,
): void {
  const errorMessage = error instanceof Error ? error.message : error;
  auditLog("ERROR", operation, { error: errorMessage, ...details });
}

/**
 * Log a warning
 */
export function logWarn(operation: string, details?: Record<string, unknown>): void {
  auditLog("WARN", operation, details);
}

/**
 * Get recent log entries
 */
export function getRecentLogs(count: number = 50): AuditLogEntry[] {
  return logBuffer.slice(-count);
}

/**
 * Get logs filtered by level
 */
export function getLogsByLevel(level: LogLevel): AuditLogEntry[] {
  return logBuffer.filter((entry) => entry.level === level);
}

/**
 * Clear log buffer
 */
export function clearLogs(): void {
  logBuffer.length = 0;
}

/**
 * Export logs to file
 */
export async function exportLogs(filePath: string): Promise<void> {
  const logContent = logBuffer.map((entry) => JSON.stringify(entry)).join("\n");

  await fs.writeFile(filePath, logContent, "utf8");
}

/**
 * Get audit summary
 */
export function getAuditSummary(): {
  total: number;
  byLevel: Record<LogLevel, number>;
  recentErrors: AuditLogEntry[];
} {
  const byLevel: Record<LogLevel, number> = {
    INFO: 0,
    SKIP: 0,
    ERROR: 0,
    WARN: 0,
  };

  for (const entry of logBuffer) {
    byLevel[entry.level]++;
  }

  return {
    total: logBuffer.length,
    byLevel,
    recentErrors: logBuffer.filter((e) => e.level === "ERROR").slice(-10),
  };
}

// Sanitize sensitive data from logs
function sanitizeLogDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...details };

  // Remove potentially sensitive fields
  const sensitiveFields = ["password", "token", "key", "secret", "auth"];

  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = "[REDACTED]";
    }
  }

  return sanitized;
}
