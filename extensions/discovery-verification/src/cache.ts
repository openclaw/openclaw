/**
 * Tiny in-memory TTL cache for discovery results.
 *
 * Stores both positive results (a discovery document was found) and
 * negative results (the domain authoritatively reported 404/410 for
 * `/.well-known/agent-discovery.json`). Transient failures are NOT
 * cached -- they should retry on the next call.
 */

import type { DiscoveryResult } from "./types.js";

export type CachedEntry =
  | { readonly kind: "positive"; readonly result: DiscoveryResult; readonly expiresAt: number }
  | { readonly kind: "negative"; readonly expiresAt: number };

export class DiscoveryCache {
  private readonly store = new Map<string, CachedEntry>();

  constructor(private readonly ttlMs: number) {}

  get(domain: string, now: number = Date.now()): CachedEntry | undefined {
    const entry = this.store.get(domain);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.store.delete(domain);
      return undefined;
    }
    return entry;
  }

  setPositive(domain: string, result: DiscoveryResult, now: number = Date.now()): void {
    this.store.set(domain, {
      kind: "positive",
      result,
      expiresAt: now + this.ttlMs,
    });
  }

  setNegative(domain: string, now: number = Date.now()): void {
    this.store.set(domain, {
      kind: "negative",
      expiresAt: now + this.ttlMs,
    });
  }

  /** Test helper -- clears all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Test helper -- returns current size. */
  size(): number {
    return this.store.size;
  }
}
