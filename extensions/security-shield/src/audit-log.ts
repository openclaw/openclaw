/**
 * Audit logger for tool call activity.
 *
 * Writes one JSON line per tool call to ~/.openclaw/security-audit.jsonl.
 * Each entry records the tool name, parameters (truncated), result summary,
 * any security findings, and whether the call was blocked.
 */

import { existsSync, mkdirSync, appendFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuditEntry = {
  timestamp: string;
  toolName: string;
  params: string;
  blocked: boolean;
  blockReason?: string;
  findings: Array<{ ruleId: string; severity?: string; message: string }>;
  durationMs?: number;
  error?: string;
};

const MAX_PARAMS_LENGTH = 500;

let logPath: string | null = null;

function getLogPath(): string {
  if (!logPath) {
    const dir = join(homedir(), ".openclaw");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    logPath = join(dir, "security-audit.jsonl");
  }
  return logPath;
}

/**
 * Append an audit entry to the log file.
 * Errors are silently ignored to avoid disrupting normal operation.
 */
export function writeAuditEntry(entry: AuditEntry): void {
  try {
    const line = JSON.stringify({
      ...entry,
      params:
        entry.params.length > MAX_PARAMS_LENGTH
          ? entry.params.slice(0, MAX_PARAMS_LENGTH) + "...(truncated)"
          : entry.params,
    });
    const path = getLogPath();
    const isNew = !existsSync(path);
    appendFileSync(path, line + "\n", { encoding: "utf-8", mode: 0o600 });
    if (isNew) chmodSync(path, 0o600);
  } catch {
    // Audit logging should never break tool execution
  }
}

/** Override the log path (for testing). */
export function setAuditLogPath(path: string): void {
  logPath = path;
}
