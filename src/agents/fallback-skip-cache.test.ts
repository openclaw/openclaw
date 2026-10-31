import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFallbackCandidateSkipReason,
  isFallbackCandidateSkipped,
  markFallbackCandidateSkipped,
} from "./fallback-skip-cache.js";
import {
  listFallbackSkipCacheSessionIdsForTest,
  resetFallbackSkipCacheForTest,
} from "./fallback-skip-cache.test-support.js";

const candidate = { sessionId: "s1", provider: "anthropic", model: "claude-opus-4-7" };
function mark(overrides: Partial<Parameters<typeof markFallbackCandidateSkipped>[0]> = {}) {
  markFallbackCandidateSkipped({ ...candidate, reason: "auth", now: 1_000, ...overrides });
}
function skipped(
  now: number,
  overrides: Partial<Parameters<typeof isFallbackCandidateSkipped>[0]> = {},
) {
  return isFallbackCandidateSkipped({ ...candidate, now, ...overrides });
}

describe("fallback-skip-cache", () => {
  beforeEach(resetFallbackSkipCacheForTest);
  afterEach(() => {
    vi.unstubAllEnvs();
    resetFallbackSkipCacheForTest();
  });

  it("treats falsy sessionId as a no-op for both mark and check", () => {
    // Missing scope must never suppress candidates across conversations.
    mark({ sessionId: undefined });
    expect(skipped(1_000, { sessionId: undefined })).toBe(false);
    expect(skipped(1_000, { sessionId: "" })).toBe(false);
  });

  it("expires entries after the TTL elapses", () => {
    mark({ reason: "auth_permanent", ttlMs: 10_000 });
    expect(skipped(10_000)).toBe(true);
    expect(skipped(11_001)).toBe(false);
    expect(getFallbackCandidateSkipReason({ ...candidate, now: 11_001 })).toBeUndefined();
  });

  it("isolates entries across explicit and automatic auth scopes", () => {
    mark({ authScope: "anthropic:profile-a", ttlMs: 60_000 });
    expect(skipped(30_000, { authScope: "anthropic:profile-a" })).toBe(true);
    expect(skipped(30_000, { authScope: "anthropic:profile-b" })).toBe(false);
    expect(skipped(30_000)).toBe(false);
  });

  it("re-marking the same triple refreshes the TTL", () => {
    mark({ ttlMs: 10_000 });
    mark({ reason: "auth_permanent", now: 10_000, ttlMs: 10_000 });
    expect(skipped(19_000)).toBe(true);
    expect(getFallbackCandidateSkipReason({ ...candidate, now: 19_000 })).toBe("auth_permanent");
  });

  it("prunes expired buckets from sessions that are never queried again", () => {
    mark({ sessionId: "one-off-1", ttlMs: 10_000 });
    mark({
      sessionId: "one-off-2",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      ttlMs: 10_000,
    });
    expect(listFallbackSkipCacheSessionIdsForTest()).toEqual(["one-off-1", "one-off-2"]);
    mark({ sessionId: "later", now: 100_000, ttlMs: 10_000 });
    expect(listFallbackSkipCacheSessionIdsForTest()).toEqual(["later"]);
  });

  it("does not skip by default when ttlMs is omitted", () => {
    mark();
    expect(skipped(1_000)).toBe(false);
  });

  it("does not enable the cache for a suffixed TTL value", () => {
    vi.stubEnv("OPENCLAW_FALLBACK_SKIP_TTL_MS", "1000ms");
    mark();
    expect(skipped(1_000)).toBe(false);
  });

  it("uses OPENCLAW_FALLBACK_SKIP_TTL_MS as an opt-in default TTL", () => {
    vi.stubEnv("OPENCLAW_FALLBACK_SKIP_TTL_MS", "60000");
    mark();
    expect(skipped(60_000)).toBe(true);
    expect(skipped(61_001)).toBe(false);
  });
});
