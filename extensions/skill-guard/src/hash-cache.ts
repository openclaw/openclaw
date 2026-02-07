/**
 * In-memory + disk manifest cache.
 *
 * On startup the cache is loaded from disk (if available).
 * After each successful cloud sync the cache is updated in memory
 * and persisted asynchronously to disk.
 */

import fs from "node:fs";
import path from "node:path";
import type { ManifestResponse, ManifestSkill } from "./types.js";

export type CachedManifest = ManifestResponse & {
  /** ISO timestamp of when the manifest was fetched. */
  fetchedAt: string;
};

export class HashCache {
  private manifest: CachedManifest | null = null;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Try to load a cached manifest from disk.  Silently ignores errors. */
  loadFromDisk(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      this.manifest = JSON.parse(raw) as CachedManifest;
    } catch {
      // No cache or corrupted — that's fine.
    }
  }

  /** Persist the current manifest to disk (sync to keep it simple). */
  persistToDisk(): void {
    if (!this.manifest) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.manifest, null, 2), "utf-8");
    } catch {
      // Best-effort; don't crash on write failure.
    }
  }

  /** Update the in-memory cache with a fresh manifest and persist. */
  update(manifest: ManifestResponse): void {
    this.manifest = {
      ...manifest,
      fetchedAt: new Date().toISOString(),
    };
    this.persistToDisk();
  }

  /** Get the cached manifest version (used as ETag for conditional requests). */
  getVersion(): string | undefined {
    return this.manifest?.store.version;
  }

  /** Get skill metadata from the cached manifest. */
  getSkill(name: string): ManifestSkill | undefined {
    return this.manifest?.skills[name];
  }

  /** Get the full cached manifest. */
  getManifest(): CachedManifest | null {
    return this.manifest;
  }

  /** Get the blocklist from the cached manifest. */
  getBlocklist(): string[] {
    return this.manifest?.blocklist ?? [];
  }

  /** Check if the cache has been populated (from disk or cloud). */
  hasData(): boolean {
    return this.manifest !== null;
  }

  /** Clear in-memory cache (for testing). */
  clear(): void {
    this.manifest = null;
  }
}
