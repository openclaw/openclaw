/**
 * Generic JSON-backed config store with file persistence.
 * Loads from disk on construction (falls back to defaults on failure),
 * merges partial updates, and writes back synchronously.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonConfigStore<T extends Record<string, unknown>> {
  private data: T;
  private readonly filePath: string;

  constructor(filePath: string, defaults: T) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.data = this.loadOrDefault(defaults);
  }

  private loadOrDefault(defaults: T): T {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as T;
      // Merge with defaults so new keys are picked up on upgrade
      return { ...defaults, ...parsed };
    } catch {
      return { ...defaults };
    }
  }

  /** Return a deep copy of the current config. */
  get(): T {
    return JSON.parse(JSON.stringify(this.data)) as T;
  }

  /** Merge partial updates and persist to disk. */
  update(partial: Partial<T>): T {
    this.data = { ...this.data, ...partial };
    this.save();
    return this.get();
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }
}
