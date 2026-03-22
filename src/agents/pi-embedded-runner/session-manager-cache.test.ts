import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";

type SessionManagerCacheModule = typeof import("./session-manager-cache.js");

describe("session manager cache", () => {
  let savedSessionManagerTtl: string | undefined;

  beforeEach(() => {
    savedSessionManagerTtl = process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS;
    process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS = "5000";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
  });

  afterEach(() => {
    if (savedSessionManagerTtl === undefined) {
      delete process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS = savedSessionManagerTtl;
    }
    vi.useRealTimers();
  });

  it("prunes expired entries during later cache activity even without revisiting them", async () => {
    const cache = await importFreshModule<SessionManagerCacheModule>(
      import.meta.url,
      "./session-manager-cache.js?session-manager-cache-prune-on-access",
    );

    cache.__testing.resetSessionManagerCache();
    cache.trackSessionManagerAccess("/tmp/stale-session.jsonl");
    expect(cache.__testing.getSessionManagerCacheKeys()).toEqual(["/tmp/stale-session.jsonl"]);

    await vi.advanceTimersByTimeAsync(6_000);

    cache.trackSessionManagerAccess("/tmp/fresh-session.jsonl");
    expect(cache.__testing.getSessionManagerCacheKeys()).toEqual(["/tmp/fresh-session.jsonl"]);
  });
});
