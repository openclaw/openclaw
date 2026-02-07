/**
 * JSONL audit logger for Skill Guard events.
 *
 * Each call to `record()` appends one JSON line to the log file.
 * The logger creates the directory and file on first write.
 */

import fs from "node:fs";
import path from "node:path";
import type { AuditEventType, AuditRecord } from "./types.js";

export type AuditLogInput = {
  event: AuditEventType;
  skill?: string;
  source?: string;
  reason?: string;
  detail?: string;
};

export class AuditLogger {
  private filePath: string;
  private fd: number | null = null;
  private enabled: boolean;

  constructor(filePath: string, enabled = true) {
    this.filePath = filePath;
    this.enabled = enabled;
  }

  /** Open the log file (creates directory if needed). */
  init(): void {
    if (!this.enabled) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      this.fd = fs.openSync(this.filePath, "a");
    } catch {
      // Best-effort — don't crash if we can't open the log.
      this.fd = null;
    }
  }

  /** Append a single audit record. */
  record(input: AuditLogInput): void {
    if (!this.enabled || this.fd === null) return;
    const rec: AuditRecord = {
      ts: new Date().toISOString(),
      ...input,
    };
    try {
      fs.writeSync(this.fd, JSON.stringify(rec) + "\n");
    } catch {
      // Best-effort write.
    }
  }

  /** Close the log file descriptor. */
  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
  }

  /** Return the log file path (for testing). */
  getFilePath(): string {
    return this.filePath;
  }
}
