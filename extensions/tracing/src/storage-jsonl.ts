import * as fs from "node:fs";
import * as path from "node:path";
import type { TraceSpan } from "./types.js";

/**
 * Writes and reads TraceSpan objects as JSONL files keyed by date.
 * Each day gets its own file: `YYYY-MM-DD.jsonl`.
 */
export class JsonlTraceWriter {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Append a span as a JSON line to the date-keyed file based on span.startMs. */
  write(span: TraceSpan): void {
    const dateKey = this.dateKeyFromMs(span.startMs);
    const filePath = path.join(this.dir, `${dateKey}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(span) + "\n");
  }

  private static readonly DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** Read all spans from a specific date file. Skips malformed lines. */
  readByDate(dateKey: string): TraceSpan[] {
    if (!JsonlTraceWriter.DATE_KEY_RE.test(dateKey)) return [];
    const filePath = path.join(this.dir, `${dateKey}.jsonl`);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, "utf-8");
    const spans: TraceSpan[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        spans.push(JSON.parse(trimmed) as TraceSpan);
      } catch {
        // skip malformed lines
      }
    }
    return spans;
  }

  /** Shorthand: read today's spans. */
  readToday(): TraceSpan[] {
    return this.readByDate(this.dateKeyFromMs(Date.now()));
  }

  /** List available trace dates, sorted newest first. */
  listDates(): string[] {
    if (!fs.existsSync(this.dir)) return [];

    const files = fs.readdirSync(this.dir);
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort()
      .reverse();
  }

  /** Remove JSONL files older than `retentionDays` days from today. */
  cleanup(retentionDays: number): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffKey = this.dateKeyFromMs(cutoff.getTime());

    for (const dateKey of this.listDates()) {
      if (dateKey < cutoffKey) {
        try {
          fs.unlinkSync(path.join(this.dir, `${dateKey}.jsonl`));
        } catch {
          // file may already be deleted or locked; skip
        }
      }
    }
  }

  /** Convert epoch ms to YYYY-MM-DD using UTC. */
  private dateKeyFromMs(ms: number): string {
    const d = new Date(ms);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}
