/**
 * Smart Cache - TTL-based caching with memory and database persistence
 */

import * as crypto from "crypto";
import type { Database } from "../db/database.js";
import type { CacheRecord } from "../db/database.js";

export class SmartCache {
  private db: Database;
  private memoryCache: Map<string, { value: unknown; expires: number }>;
  private maxMemoryItems: number;

  constructor(db: Database, maxMemoryItems: number = 1000) {
    this.db = db;
    this.memoryCache = new Map();
    this.maxMemoryItems = maxMemoryItems;
    this.loadFromDatabase();
  }

  private loadFromDatabase(): void {
    try {
      const db = this.db.getDb();
      const now = new Date().toISOString();

      db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(now);

      const validRecords = db
        .prepare("SELECT * FROM cache WHERE expires_at > ?")
        .all(now) as CacheRecord[];
      for (const record of validRecords) {
        try {
          const value = JSON.parse(record.response);
          const expires = new Date(record.expires_at).getTime();
          if (expires > Date.now()) {
            if (this.memoryCache.size < this.maxMemoryItems) {
              this.memoryCache.set(record.cache_key, { value, expires });
            }
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    } catch {
      // Table may not exist yet
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const cached = this.memoryCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.value as T;
    }

    this.memoryCache.delete(key);

    try {
      const db = this.db.getDb();
      const now = new Date().toISOString();

      const record = db
        .prepare("SELECT * FROM cache WHERE cache_key = ? AND expires_at > ?")
        .get(key, now) as CacheRecord | undefined;

      if (!record) return null;

      const value = JSON.parse(record.response) as T;
      const expires = new Date(record.expires_at).getTime();

      if (this.memoryCache.size < this.maxMemoryItems) {
        this.memoryCache.set(key, { value, expires });
      }

      return value;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const expires = Date.now() + ttlMs;
    const expiresAt = new Date(expires).toISOString();
    const serialized = JSON.stringify(value);

    if (ttlMs > 60000 && this.memoryCache.size < this.maxMemoryItems) {
      this.memoryCache.set(key, { value, expires });
    }

    try {
      const db = this.db.getDb();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO cache (cache_key, response, expires_at, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          response = ?,
          expires_at = ?,
          created_at = ?
      `).run(key, serialized, expiresAt, now, serialized, expiresAt, now);
    } catch {
      // Table may not exist
    }
  }

  async delete(key: string): Promise<void> {
    this.memoryCache.delete(key);

    try {
      const db = this.db.getDb();
      db.prepare("DELETE FROM cache WHERE cache_key = ?").run(key);
    } catch {
      // Table may not exist
    }
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();

    try {
      const db = this.db.getDb();
      db.prepare("DELETE FROM cache").run();
    } catch {
      // Table may not exist
    }
  }

  static generateKey(...parts: unknown[]): string {
    const normalized = parts
      .map((part) => {
        if (part === null || part === undefined) return "";
        if (typeof part === "object") return JSON.stringify(part);
        return String(part);
      })
      .join(":");

    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  }
}
