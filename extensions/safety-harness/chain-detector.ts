import fs from "node:fs";
import path from "node:path";

export type LedgerEntry = {
  tool: string;
  verb: string;
  target: string;
  ts?: number;
};

export type ChainRule = {
  name: string;
  detect: (ledger: LedgerEntry[], candidate: LedgerEntry, now: number) => boolean;
};

const FIVE_MINUTES = 5 * 60_000;
const TEN_MINUTES = 10 * 60_000;
const SIXTY_MINUTES = 60 * 60_000;
const MAX_LEDGER_SIZE = 200;

export const DEFAULT_CHAIN_RULES: ChainRule[] = [
  {
    name: "read-then-exfiltrate",
    detect(ledger, candidate, now) {
      if (candidate.verb !== "export") return false;
      return ledger.some(
        (e) =>
          e.verb === "read" &&
          ["email", "contacts", "calendar"].includes(e.target) &&
          now - (e.ts ?? 0) <= FIVE_MINUTES,
      );
    },
  },
  {
    name: "mass-read-scraping",
    detect(ledger, candidate, now) {
      if (candidate.verb !== "read") return false;
      const recentReads = ledger.filter(
        (e) => e.verb === "read" && now - (e.ts ?? 0) <= TEN_MINUTES,
      );
      return recentReads.length > 50;
    },
  },
  {
    // Gap 1: Cumulative delete detection — catches drip-style deletion
    name: "mass-delete-drip",
    detect(ledger, candidate, now) {
      if (candidate.verb !== "delete") return false;
      const recentDeletes = ledger.filter(
        (e) => e.verb === "delete" && now - (e.ts ?? 0) <= SIXTY_MINUTES,
      );
      return recentDeletes.length >= 10;
    },
  },
];

export class ChainDetector {
  private ledger: LedgerEntry[] = [];

  constructor(
    private rules: ChainRule[] = DEFAULT_CHAIN_RULES,
    private persistPath?: string, // Gap 8: optional disk persistence
  ) {
    if (persistPath) this.loadFromDisk();
  }

  /** Record an action in the ledger. */
  record(entry: LedgerEntry): void {
    this.ledger.push({ ...entry, ts: entry.ts ?? Date.now() });
    this.prune();
    if (this.persistPath) this.persistToDisk();
  }

  /** Check if the candidate action triggers any chain rules. */
  check(candidate: LedgerEntry): string[] {
    const now = Date.now();
    const flags: string[] = [];
    for (const rule of this.rules) {
      if (rule.detect(this.ledger, { ...candidate, ts: now }, now)) {
        flags.push(rule.name);
      }
    }
    return flags;
  }

  /** Prune entries older than 60 minutes or beyond max size. */
  private prune(): void {
    const cutoff = Date.now() - SIXTY_MINUTES;
    this.ledger = this.ledger.filter((e) => (e.ts ?? 0) > cutoff);
    if (this.ledger.length > MAX_LEDGER_SIZE) {
      this.ledger = this.ledger.slice(-MAX_LEDGER_SIZE);
    }
  }

  /** Gap 8: Persist ledger to disk. */
  private persistToDisk(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.ledger));
    } catch {
      // Best effort
    }
  }

  /** Gap 8: Load ledger from disk on startup. */
  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
      if (Array.isArray(data)) {
        this.ledger = data;
        this.prune();
      }
    } catch {
      // Corrupted or missing — start fresh
    }
  }
}
