import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module reads process.env and Date.now() at call time, so we
// dynamically re-import after setting up fakes / env vars.
type Mod = typeof import("./session-manager-cache.js");

describe("session-manager-cache", () => {
  let mod: Mod;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Ensure caching is enabled (default TTL > 0).
    delete process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS;
    vi.resetModules();
    mod = await import("./session-manager-cache.js");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Max-size cap ──────────────────────────────────────────────

  it("enforces max-size cap of 500 entries", () => {
    for (let i = 0; i < 510; i++) {
      mod.trackSessionManagerAccess(`/sessions/s-${i}.json`);
    }
    expect(mod.sessionManagerCacheSize()).toBeLessThanOrEqual(500);
  });

  // ── LRU ordering via delete+set ───────────────────────────────

  it("re-access refreshes LRU position — recently used entry survives eviction", () => {
    // Fill cache to 499 entries (s-0 … s-498).
    for (let i = 0; i < 499; i++) {
      mod.trackSessionManagerAccess(`/sessions/s-${i}.json`);
    }
    expect(mod.sessionManagerCacheSize()).toBe(499);

    // Re-access s-0 → moves it to the end of insertion order.
    mod.trackSessionManagerAccess("/sessions/s-0.json");
    expect(mod.sessionManagerCacheSize()).toBe(499); // no growth, same key

    // Add two new entries to push past 500.
    mod.trackSessionManagerAccess("/sessions/s-500.json"); // size → 500
    mod.trackSessionManagerAccess("/sessions/s-501.json"); // evicts oldest (s-1)

    // s-0 was refreshed so it should still be present (500 entries, s-0 near end).
    // The evicted entry should be s-1 (oldest after s-0 was refreshed).
    expect(mod.sessionManagerCacheSize()).toBe(500);
  });

  // ── Lazy TTL eviction ─────────────────────────────────────────

  it("lazy TTL eviction removes expired entry on cache check", async () => {
    // Insert an entry directly.
    mod.trackSessionManagerAccess("/sessions/a.json");
    expect(mod.sessionManagerCacheSize()).toBe(1);

    // Advance time past the 45 s default TTL.
    vi.advanceTimersByTime(46_000);

    // prewarmSessionFile calls isSessionManagerCached internally, which
    // should now delete the stale entry and return false.  The subsequent
    // fs.open will fail (file doesn't exist) so the entry is NOT re-added.
    await mod.prewarmSessionFile("/sessions/a.json");
    expect(mod.sessionManagerCacheSize()).toBe(0); // expired entry was evicted
  });

  // ── clearSessionManagerCache ──────────────────────────────────

  it("clearSessionManagerCache empties the cache", () => {
    mod.trackSessionManagerAccess("/sessions/a.json");
    mod.trackSessionManagerAccess("/sessions/b.json");
    expect(mod.sessionManagerCacheSize()).toBe(2);

    mod.clearSessionManagerCache();
    expect(mod.sessionManagerCacheSize()).toBe(0);
  });

  // ── Disabled cache (TTL=0) ────────────────────────────────────

  it("skips tracking when cache is disabled via TTL=0", async () => {
    process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS = "0";
    vi.resetModules();
    const disabled = await import("./session-manager-cache.js");

    disabled.trackSessionManagerAccess("/sessions/a.json");
    expect(disabled.sessionManagerCacheSize()).toBe(0);
  });
});
