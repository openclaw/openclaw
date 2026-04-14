/**
 * In-memory cache for group membership verification.
 * Used by groupPolicy "members" to ensure all group participants are trusted.
 */

import { createHash } from "node:crypto";
import type { Api } from "grammy";
import { logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import type { NormalizedAllowFrom } from "./bot-access.js";

const TTL_MS = 5 * 60 * 1000; // 5 minutes

type MembershipResult = {
  trusted: boolean;
  reason?: string;
};

type CacheEntry = {
  result: MembershipResult;
  timestamp: number;
};

const cache = new Map<string, CacheEntry>();

function startEvictionTimer(): ReturnType<typeof setInterval> {
  // Periodic eviction sweep: remove stale entries so the cache stays bounded
  // on long-lived gateways. unref() ensures this timer doesn't keep the process alive.
  return setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
      if (now - entry.timestamp >= TTL_MS) {
        cache.delete(key);
      }
    }
  }, TTL_MS).unref();
}

let evictionTimer = startEvictionTimer();

// Cache key includes botId so two bots sharing a gateway and monitoring the
// same group with identical allowlists don't share a cached trusted result.
function getChatKey(
  chatId: number | string,
  botId: number,
  allowFrom: NormalizedAllowFrom,
): string {
  const sorted = allowFrom.entries.toSorted();
  const payload = `${botId}:${allowFrom.hasWildcard ? "1" : "0"}:${sorted.join(",")}`;
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 12);
  return `${chatId}:${hash}`;
}

// Usernames (@handle) and other strings are skipped — Telegram's getChatMember
// requires numeric user IDs.
function extractNumericIds(allow: NormalizedAllowFrom): number[] {
  return allow.entries.filter((e) => /^\d+$/.test(e)).map(Number);
}

export async function verifyGroupMembership(params: {
  chatId: number | string;
  api: Api;
  botId: number;
  allowFrom: NormalizedAllowFrom;
}): Promise<MembershipResult> {
  const { chatId, api, botId, allowFrom } = params;
  const key = getChatKey(chatId, botId, allowFrom);

  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < TTL_MS) {
    return cached.result;
  }

  if (allowFrom.hasWildcard) {
    const result: MembershipResult = { trusted: true };
    cache.set(key, { result, timestamp: Date.now() });
    return result;
  }

  const numericIds = extractNumericIds(allowFrom);
  if (numericIds.length === 0) {
    logVerbose(
      warn(
        `[members] No numeric IDs in allowFrom for chat ${chatId}; cannot verify membership. Use numeric Telegram user IDs.`,
      ),
    );
    const result: MembershipResult = { trusted: false, reason: "no-numeric-ids" };
    cache.set(key, { result, timestamp: Date.now() });
    return result;
  }

  // The bot itself is always a trusted group member.
  const trustedIds = new Set(numericIds);
  trustedIds.add(botId);

  try {
    const totalCount = await api.getChatMemberCount(Number(chatId));

    // Fast path: if there are more members than trusted IDs, at least one must be untrusted.
    if (totalCount > trustedIds.size) {
      const result: MembershipResult = {
        trusted: false,
        reason: `member-count-mismatch: ${totalCount} members but only ${trustedIds.size} trusted IDs`,
      };
      cache.set(key, { result, timestamp: Date.now() });
      return result;
    }

    let presentCount = 0;
    let transientErrors = 0;
    for (const userId of trustedIds) {
      try {
        const member = await api.getChatMember(Number(chatId), userId);
        if (member.status !== "left" && member.status !== "kicked") {
          presentCount++;
        }
      } catch {
        // A per-member lookup failure is treated as indeterminate rather than
        // "absent": a transient Telegram API/network hiccup would otherwise be
        // cached as `untrusted-members` for the full TTL and block every
        // subsequent message until the cache expires. Fail closed (do not
        // increment presentCount) but skip caching below so the next call
        // retries instead of being locked out.
        transientErrors++;
      }
    }

    const trusted = presentCount === totalCount;
    const result: MembershipResult = trusted
      ? { trusted: true }
      : {
          trusted: false,
          reason: `untrusted-members: ${totalCount} total, ${presentCount} trusted`,
        };
    // Only cache results that were determined purely from successful API calls.
    // If any per-member lookup failed and we still treated it as untrusted, skip
    // caching so the next message retries instead of inheriting the transient
    // failure for the full TTL window.
    if (trusted || transientErrors === 0) {
      cache.set(key, { result, timestamp: Date.now() });
    }
    return result;
  } catch {
    // Do not cache top-level API failures (e.g. getChatMemberCount timeout):
    // a one-off hiccup would otherwise lock the group out for the full TTL
    // even after Telegram recovers seconds later.
    return { trusted: false, reason: "api-error" };
  }
}

/**
 * Invalidate cached membership for a specific chat (e.g. on member join/leave).
 * Removes all entries for this chatId regardless of allowFrom hash.
 */
export function invalidateGroupMembership(chatId: number | string): void {
  const prefix = `${chatId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

/**
 * Clear all cached entries and restart the eviction timer.
 *
 * Intended for tests (call in afterEach). Stops the current sweep interval,
 * clears all entries, then immediately starts a fresh interval so subsequent
 * tests that use fake timers get a predictable timer state.
 *
 * @internal
 */
export function clearGroupMembershipCache(): void {
  clearInterval(evictionTimer);
  cache.clear();
  // Restart the sweep so the module is in a clean, ready state for the next use.
  evictionTimer = startEvictionTimer();
}

/**
 * Return the current number of entries in the cache.
 * Exposed for testing only — do not rely on this in production code.
 *
 * @internal
 */
export function getMembershipCacheSize(): number {
  return cache.size;
}
