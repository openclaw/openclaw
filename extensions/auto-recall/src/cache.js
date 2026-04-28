import { createHash } from "node:crypto";

/**
 * Serialize a JSON-like value with stable object key ordering.
 * @param {unknown} value Value to serialize.
 * @returns {string} Stable JSON representation.
 */
export function stableJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

/**
 * Build a short SHA-256 based hex hash.
 * @param {unknown} value Value to hash.
 * @param {number} [length=16] Number of hex characters to return.
 * @returns {string} Short hash.
 */
export function hash(value, length = 16) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

/**
 * Hash backend configuration with stable key ordering.
 * @param {unknown} value Backend configuration object.
 * @returns {string} Stable configuration hash.
 */
export function configHash(value) {
  return hash(stableJson(value), 16);
}

/**
 * Normalize user text for cache lookups without keeping metadata envelopes.
 * @param {unknown} text Raw user text.
 * @returns {string} Normalized cache key text.
 */
export function normalizeCacheText(text) {
  return (text == null ? "" : String(text))
    .toLowerCase()
    .replace(/```json[\s\S]*?```/gi, " ")
    .replace(/\[(mon|tue|wed|thu|fri|sat|sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} utc\]/gi, " ")
    .replace(/\b(?:conversation info|sender|replied message|forwarded message)\b.*$/gim, " ")
    .replace(/[{}[\]",:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

/**
 * Build an isolated cache key for backend, session, text, and optional suffix.
 * @param {{backend: {kind: string, name: string, configHash?: string}, text: string, session?: unknown, suffix?: string}} params Cache key parts.
 * @returns {string} Cache key.
 */
export function cacheKeyFor({ backend, text, session, suffix = "" }) {
  const sessionHash = session ? hash(stableJson(session), 16) : "no-session";
  const namespace = `${backend.kind}:${backend.name}:${backend.configHash || "no-config"}:${sessionHash}:${suffix || ""}`;
  return `${hash(namespace)}:${hash(normalizeCacheText(text))}`;
}

/**
 * Small in-memory TTL cache with expired-entry and LRU eviction.
 */
export class RecallCache {
  constructor({
    enabled = true,
    okTtlMs = 30 * 60_000,
    notFoundTtlMs = 10 * 60_000,
    degradedTtlMs = okTtlMs,
    errorTtlMs = 0,
    maxEntries = 500,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.ttls = {
      ok: okTtlMs,
      not_found: notFoundTtlMs,
      degraded: degradedTtlMs,
      error: errorTtlMs,
    };
    this.maxEntries = Math.max(1, Number(maxEntries) || 500);
    this.map = new Map();
  }

  ttlFor(status, override) {
    if (Number.isFinite(override)) {
      return Math.max(0, Number(override));
    }
    return Math.max(0, Number(this.ttls[status] ?? 0));
  }

  get(key, now = Date.now()) {
    if (!this.enabled) {
      return undefined;
    }
    const entry = this.map.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    entry.lastAccess = now;
    return entry.value;
  }

  set(key, value, ttlMs, now = Date.now()) {
    if (!this.enabled || !key || ttlMs <= 0) {
      return false;
    }
    this.map.set(key, { value, expiresAt: now + ttlMs, lastAccess: now });
    this.sweep(now);
    return true;
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key);
      }
    }
    while (this.map.size > this.maxEntries) {
      let oldestKey;
      let oldest = Infinity;
      for (const [key, entry] of this.map) {
        if (entry.lastAccess < oldest) {
          oldest = entry.lastAccess;
          oldestKey = key;
        }
      }
      if (!oldestKey) {
        break;
      }
      this.map.delete(oldestKey);
    }
  }
}
