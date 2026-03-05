import fs from "node:fs";
import path from "node:path";
import type { VerbCategory } from "./verb-classifier.js";

type RateLimitCategory = "read" | "write" | "delete" | "export";

export type RateLimitConfig = Record<RateLimitCategory, number>;

/** Default limits from design doc: per hour */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  read: 100,
  write: 20,
  delete: 5,
  export: 5,
};

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export class RateLimiter {
  private timestamps: Record<RateLimitCategory, number[]> = {
    read: [],
    write: [],
    delete: [],
    export: [],
  };

  constructor(
    private limits: RateLimitConfig = DEFAULT_RATE_LIMITS,
    private windowMs: number = DEFAULT_WINDOW_MS,
    private persistPath?: string, // Gap 8: optional disk persistence
  ) {
    if (persistPath) this.loadFromDisk();
  }

  /** Prune timestamps outside the sliding window. */
  private prune(category: RateLimitCategory): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps[category] = this.timestamps[category].filter((t) => t > cutoff);
  }

  /** Check if a call of this category would be within limits. */
  check(category: RateLimitCategory): boolean {
    this.prune(category);
    return this.timestamps[category].length < this.limits[category];
  }

  /** Record a call of this category. */
  record(category: RateLimitCategory): void {
    this.timestamps[category].push(Date.now());
    if (this.persistPath) this.persistToDisk();
  }

  /** Get current count for a category (pruned). */
  getCount(category: RateLimitCategory): number {
    this.prune(category);
    return this.timestamps[category].length;
  }

  /** Get all current counts (for audit log). */
  getCounts(): Record<RateLimitCategory, number> {
    return {
      read: this.getCount("read"),
      write: this.getCount("write"),
      delete: this.getCount("delete"),
      export: this.getCount("export"),
    };
  }

  /** Check if a VerbCategory maps to a rate-limited category. */
  static toRateCategory(verb: VerbCategory): RateLimitCategory | null {
    if (verb === "unknown") return null;
    return verb as RateLimitCategory;
  }

  /** Gap 8: Persist state to disk. */
  private persistToDisk(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.timestamps));
    } catch {
      // Best effort — don't crash if persistence fails
    }
  }

  /** Gap 8: Load state from disk on startup. */
  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
      for (const cat of ["read", "write", "delete", "export"] as RateLimitCategory[]) {
        if (Array.isArray(data[cat])) {
          this.timestamps[cat] = data[cat];
        }
      }
      // Prune stale entries after loading
      for (const cat of ["read", "write", "delete", "export"] as RateLimitCategory[]) {
        this.prune(cat);
      }
    } catch {
      // Corrupted or missing — start fresh (conservative, per Gap 8 resolution)
    }
  }
}
