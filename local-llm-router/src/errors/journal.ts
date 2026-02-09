/**
 * Error journal — captures all failures with full context.
 * Separate from audit log (which captures everything).
 * This captures ONLY failures for daily analysis.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ErrorEntry, ErrorType, AgentId } from "../types.js";

const JOURNAL_FILENAME = "journal.jsonl";

export class ErrorJournal {
  private errorsDir: string;

  constructor(errorsDir: string) {
    this.errorsDir = errorsDir;
  }

  private get journalPath(): string {
    return path.join(this.errorsDir, JOURNAL_FILENAME);
  }

  /**
   * Record an error entry.
   */
  async capture(entry: Omit<ErrorEntry, "id" | "timestamp">): Promise<ErrorEntry> {
    await fs.mkdir(this.errorsDir, { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0].replace(/-/g, "");
    const timeStr = now.toISOString().split("T")[1].replace(/[:.]/g, "").slice(0, 6);

    const full: ErrorEntry = {
      id: `err_${dateStr}_${timeStr}`,
      timestamp: now.toISOString(),
      ...entry,
    };

    await fs.appendFile(this.journalPath, JSON.stringify(full) + "\n", "utf-8");
    return full;
  }

  /**
   * Read all entries from the journal.
   */
  async readAll(): Promise<ErrorEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.journalPath, "utf-8");
    } catch {
      return [];
    }

    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as ErrorEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is ErrorEntry => e !== null);
  }

  /**
   * Read entries from the last N hours.
   */
  async readRecent(hours: number = 24): Promise<ErrorEntry[]> {
    const all = await this.readAll();
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return all.filter((e) => e.timestamp >= cutoff);
  }

  /**
   * Read entries by error type.
   */
  async readByType(type: ErrorType): Promise<ErrorEntry[]> {
    const all = await this.readAll();
    return all.filter((e) => e.type === type);
  }

  /**
   * Read entries by agent.
   */
  async readByAgent(agent: AgentId): Promise<ErrorEntry[]> {
    const all = await this.readAll();
    return all.filter((e) => e.agent === agent);
  }

  /**
   * Get error counts grouped by type for the last N hours.
   */
  async summarize(hours: number = 24): Promise<Record<ErrorType, number>> {
    const recent = await this.readRecent(hours);
    const counts: Partial<Record<ErrorType, number>> = {};
    for (const entry of recent) {
      counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    }
    return counts as Record<ErrorType, number>;
  }
}
