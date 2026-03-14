/**
 * Audit Log: records all sensitive agent actions for compliance and debugging.
 *
 * Every action that goes through `confirm_action` (whether approved or denied)
 * is appended to a JSONL audit log file. This provides:
 * - Full traceability of what the agent did
 * - Evidence for compliance/security reviews
 * - Debug trail for unexpected agent behavior
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("acp/audit-log");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditDecision = "approved" | "denied" | "auto-approved" | "timed-out";

export type AuditEntry = {
  id: string;
  timestamp: number;
  sessionKey?: string;
  agentId?: string;
  /** Action category (e.g., "email.send", "file.delete", "api.call") */
  actionType: string;
  /** Human-readable description of what the agent wants to do */
  description: string;
  /** Structured data about the action (e.g., recipient, file path) */
  details?: Record<string, unknown>;
  decision: AuditDecision;
  /** Who/what made the decision */
  decidedBy: "user" | "system" | "timeout";
  /** Reason for denial (when denied) */
  denyReason?: string;
  /** How long the user took to respond (ms) */
  responseTimeMs?: number;
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const DEFAULT_AUDIT_LOG_PATH = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "audit.jsonl",
);

export class AuditLogger {
  private readonly logPath: string;

  constructor(logPath?: string) {
    this.logPath = logPath ?? DEFAULT_AUDIT_LOG_PATH;
  }

  /** Append an audit entry to the log. */
  append(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry {
    const full: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      ...entry,
    };

    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.appendFileSync(this.logPath, JSON.stringify(full) + "\n");
    log.debug(
      `Audit: [${full.decision}] ${full.actionType} — ${full.description.slice(0, 80)}`,
    );
    return full;
  }

  /** Read recent audit entries (last N lines). */
  readRecent(limit = 100): AuditEntry[] {
    if (!fs.existsSync(this.logPath)) return [];
    const lines = fs.readFileSync(this.logPath, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AuditEntry => e !== null);
  }

  /** Read audit entries filtered by session or action type. */
  query(filter: {
    sessionKey?: string;
    actionType?: string;
    decision?: AuditDecision;
    since?: number;
    limit?: number;
  }): AuditEntry[] {
    let entries = this.readRecent(filter.limit ?? 1000);

    if (filter.sessionKey) {
      entries = entries.filter((e) => e.sessionKey === filter.sessionKey);
    }
    if (filter.actionType) {
      entries = entries.filter((e) => e.actionType.startsWith(filter.actionType!));
    }
    if (filter.decision) {
      entries = entries.filter((e) => e.decision === filter.decision);
    }
    if (filter.since) {
      entries = entries.filter((e) => e.timestamp >= filter.since!);
    }

    return entries.slice(-(filter.limit ?? 100));
  }

  /** Format a readable audit summary for display. */
  formatSummary(entries: AuditEntry[]): string {
    if (entries.length === 0) return "No audit entries found.";

    return entries
      .map((e) => {
        const ts = new Date(e.timestamp).toISOString();
        const icon =
          e.decision === "approved" || e.decision === "auto-approved"
            ? "✓"
            : e.decision === "denied"
            ? "✗"
            : "?";
        return `${ts} ${icon} [${e.actionType}] ${e.description.slice(0, 80)} (${e.decision})`;
      })
      .join("\n");
  }
}

// Singleton
let _logger: AuditLogger | null = null;

export function getAuditLogger(logPath?: string): AuditLogger {
  if (!_logger) {
    _logger = new AuditLogger(logPath);
  }
  return _logger;
}
