/**
 * Per-day JSONL storage for usage tracking records.
 * Files stored in <stateDir>/plugins/usage-tracker/data/YYYY-MM-DD.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export type UsageRecord = {
  ts: number;
  tool: string;
  skill?: string;
  skillType?: "entry" | "sub";
  path?: string;
  session?: string;
  agent?: string;
  dur?: number;
  err?: string;
};

function formatDayKey(ts: number): string {
  const d = new Date(ts * 1000);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class UsageStorage {
  private readonly dataDir: string;

  constructor(stateDir: string) {
    this.dataDir = path.join(stateDir, "plugins", "usage-tracker", "data");
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private fileForDay(dayKey: string): string {
    return path.join(this.dataDir, `${dayKey}.jsonl`);
  }

  /** Append a single record to the appropriate day file. */
  append(record: UsageRecord): void {
    this.ensureDir();
    const dayKey = formatDayKey(record.ts);
    const filePath = this.fileForDay(dayKey);
    const line = JSON.stringify(record) + "\n";
    fs.appendFileSync(filePath, line, "utf-8");
  }

  /** Append multiple records, grouped by day for efficiency. */
  appendBatch(records: UsageRecord[]): void {
    if (records.length === 0) return;
    this.ensureDir();

    const byDay = new Map<string, string[]>();
    for (const record of records) {
      const dayKey = formatDayKey(record.ts);
      const lines = byDay.get(dayKey) ?? [];
      lines.push(JSON.stringify(record));
      byDay.set(dayKey, lines);
    }

    for (const [dayKey, lines] of byDay) {
      const filePath = this.fileForDay(dayKey);
      fs.appendFileSync(filePath, lines.join("\n") + "\n", "utf-8");
    }
  }

  /** Read all records from a specific day file. */
  async readDay(dayKey: string): Promise<UsageRecord[]> {
    const filePath = this.fileForDay(dayKey);
    if (!fs.existsSync(filePath)) return [];
    return this.readFile(filePath);
  }

  /** Read all records from a date range (inclusive). */
  async readRange(startDay: string, endDay: string): Promise<UsageRecord[]> {
    const days = this.listDays();
    const results: UsageRecord[] = [];

    for (const day of days) {
      if (day < startDay || day > endDay) continue;
      const records = await this.readDay(day);
      results.push(...records);
    }

    return results;
  }

  /** List all available day keys, sorted ascending. */
  listDays(): string[] {
    if (!fs.existsSync(this.dataDir)) return [];

    return fs
      .readdirSync(this.dataDir)
      .filter((f) => f.endsWith(".jsonl") && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, -6))
      .sort();
  }

  /** Delete a specific day file (used during backfill to replace). */
  deleteDay(dayKey: string): void {
    const filePath = this.fileForDay(dayKey);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /** Delete all data files. */
  clear(): void {
    if (!fs.existsSync(this.dataDir)) return;
    for (const f of fs.readdirSync(this.dataDir)) {
      if (f.endsWith(".jsonl")) {
        fs.unlinkSync(path.join(this.dataDir, f));
      }
    }
  }

  private async readFile(filePath: string): Promise<UsageRecord[]> {
    const records: UsageRecord[] = [];
    const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as UsageRecord;
          if (parsed && typeof parsed.ts === "number" && typeof parsed.tool === "string") {
            records.push(parsed);
          }
        } catch {
          // skip malformed lines
        }
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }

    return records;
  }
}

// ── Skill Session storage ──────────────────────────────────────────────

export type SkillSessionRecord = {
  skill: string;
  startTs: number;
  endTs: number;
  durationSec: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  subReads: number;
  endReason: string;
  session?: string;
  agent?: string;
};

const SESSIONS_FILENAME = "skill-sessions.jsonl";

export class SkillSessionStorage {
  private readonly filePath: string;
  private readonly dataDir: string;

  constructor(stateDir: string) {
    this.dataDir = path.join(stateDir, "plugins", "usage-tracker", "data");
    this.filePath = path.join(this.dataDir, SESSIONS_FILENAME);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  appendBatch(records: SkillSessionRecord[]): void {
    if (records.length === 0) return;
    this.ensureDir();
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFileSync(this.filePath, lines, "utf-8");
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
  }

  async readAll(): Promise<SkillSessionRecord[]> {
    if (!fs.existsSync(this.filePath)) return [];
    const records: SkillSessionRecord[] = [];
    const fileStream = fs.createReadStream(this.filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as SkillSessionRecord;
          if (parsed && typeof parsed.skill === "string") {
            records.push(parsed);
          }
        } catch {
          // skip
        }
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }
    return records;
  }
}
