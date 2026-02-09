/**
 * Structured audit logging.
 * Every tool execution, approval decision, and agent action is logged here.
 * Append-only JSONL for immutability.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentId, AuditEntry } from "../types.js";

export class AuditLog {
  private logDir: string;

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  /**
   * Append an audit entry. File is named by date for easy querying.
   */
  async log(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const filePath = path.join(this.logDir, `${dateStr}.jsonl`);

    await fs.mkdir(this.logDir, { recursive: true });

    const full: AuditEntry = {
      timestamp: now.toISOString(),
      ...entry,
    };
    await fs.appendFile(filePath, JSON.stringify(full) + "\n", "utf-8");
  }

  /**
   * Read audit entries for a given date.
   */
  async readDate(dateStr: string): Promise<AuditEntry[]> {
    const filePath = path.join(this.logDir, `${dateStr}.jsonl`);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      return [];
    }

    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AuditEntry => e !== null);
  }

  /**
   * Read entries for a specific agent on a given date.
   */
  async readByAgent(dateStr: string, agent: AgentId): Promise<AuditEntry[]> {
    const all = await this.readDate(dateStr);
    return all.filter((e) => e.agent === agent);
  }
}
