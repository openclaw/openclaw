/**
 * Tests for #86488: configurable subagent completion announce retry knobs.
 *
 * Covers:
 * - Default config preserves prior behavior (3 retries, 1s→2s→4s→8s backoff)
 * - `agents.defaults.subagents.maxAnnounceRetryCount` overrides the retry cap
 * - `agents.defaults.subagents.announceRetryBaseDelayMs` overrides backoff base
 * - `agents.defaults.subagents.announceRetryMaxDelayMs` overrides backoff cap
 * - `maxAnnounceRetryCount: 0` disables retries (give-up on the very first decision)
 * - `announceRetryBaseDelayMs: 0` disables delay (retries fire back-to-back)
 * - Edge cases: negative/NaN/non-finite values fall back to defaults; absurd values clamped
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSubagentAnnounceRetryBaseDelayMs,
  resolveSubagentAnnounceRetryMaxDelayMs,
  resolveSubagentMaxAnnounceRetryCount,
} from "./subagent-announce-delivery.js";
import { resolveDeferredCleanupDecision } from "./subagent-registry-cleanup.js";
import {
  DEFAULT_ANNOUNCE_RETRY_BASE_DELAY_MS,
  DEFAULT_ANNOUNCE_RETRY_MAX_DELAY_MS,
  DEFAULT_MAX_ANNOUNCE_RETRY_COUNT,
  resolveAnnounceRetryDelayMs,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeConfig(subagents: Record<string, unknown> = {}): OpenClawConfig {
  return {
    agents: { defaults: { subagents } },
  } as unknown as OpenClawConfig;
}

function makeEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "test",
    cleanup: "keep",
    createdAt: 0,
    endedAt: 1_000,
    ...overrides,
  };
}

describe("#86488: configurable subagent announce retry — config resolvers", () => {
  describe("resolveSubagentMaxAnnounceRetryCount", () => {
    it("returns the default (3) when no override is configured", () => {
      expect(resolveSubagentMaxAnnounceRetryCount(makeConfig())).toBe(
        DEFAULT_MAX_ANNOUNCE_RETRY_COUNT,
      );
    });

    it("returns the configured override when present", () => {
      expect(
        resolveSubagentMaxAnnounceRetryCount(makeConfig({ maxAnnounceRetryCount: 7 })),
      ).toBe(7);
    });

    it("allows 0 (disable retries entirely)", () => {
      expect(
        resolveSubagentMaxAnnounceRetryCount(makeConfig({ maxAnnounceRetryCount: 0 })),
      ).toBe(0);
    });

    it("clamps unreasonably large overrides to a safe ceiling (20)", () => {
      expect(
        resolveSubagentMaxAnnounceRetryCount(makeConfig({ maxAnnounceRetryCount: 9999 })),
      ).toBe(20);
    });

    it("falls back to default for negative / NaN / non-finite values", () => {
      expect(
        resolveSubagentMaxAnnounceRetryCount(makeConfig({ maxAnnounceRetryCount: -1 })),
      ).toBe(DEFAULT_MAX_ANNOUNCE_RETRY_COUNT);
      expect(
        resolveSubagentMaxAnnounceRetryCount(makeConfig({ maxAnnounceRetryCount: NaN })),
      ).toBe(DEFAULT_MAX_ANNOUNCE_RETRY_COUNT);
      expect(
        resolveSubagentMaxAnnounceRetryCount(
          makeConfig({ maxAnnounceRetryCount: Number.POSITIVE_INFINITY }),
        ),
      ).toBe(DEFAULT_MAX_ANNOUNCE_RETRY_COUNT);
    });
  });

  describe("resolveSubagentAnnounceRetryBaseDelayMs", () => {
    it("returns the default (1000 ms) when no override is configured", () => {
      expect(resolveSubagentAnnounceRetryBaseDelayMs(makeConfig())).toBe(
        DEFAULT_ANNOUNCE_RETRY_BASE_DELAY_MS,
      );
    });

    it("returns the configured override (e.g. 10s for flaky Feishu)", () => {
      expect(
        resolveSubagentAnnounceRetryBaseDelayMs(
          makeConfig({ announceRetryBaseDelayMs: 10_000 }),
        ),
      ).toBe(10_000);
    });

    it("allows 0 (no delay between retries)", () => {
      expect(
        resolveSubagentAnnounceRetryBaseDelayMs(makeConfig({ announceRetryBaseDelayMs: 0 })),
      ).toBe(0);
    });
  });

  describe("resolveSubagentAnnounceRetryMaxDelayMs", () => {
    it("returns the default (8000 ms) when no override is configured", () => {
      expect(resolveSubagentAnnounceRetryMaxDelayMs(makeConfig())).toBe(
        DEFAULT_ANNOUNCE_RETRY_MAX_DELAY_MS,
      );
    });

    it("returns the configured override (e.g. 60s max for very flaky channels)", () => {
      expect(
        resolveSubagentAnnounceRetryMaxDelayMs(
          makeConfig({ announceRetryMaxDelayMs: 60_000 }),
        ),
      ).toBe(60_000);
    });
  });
});

describe("#86488: resolveAnnounceRetryDelayMs with options", () => {
  it("preserves the original 1s→2s→4s→8s backoff when called without options", () => {
    // retryCount is "attempts already made", so retry #1 waits 1s.
    expect(resolveAnnounceRetryDelayMs(1)).toBe(1_000);
    expect(resolveAnnounceRetryDelayMs(2)).toBe(2_000);
    expect(resolveAnnounceRetryDelayMs(3)).toBe(4_000);
    expect(resolveAnnounceRetryDelayMs(4)).toBe(8_000);
    expect(resolveAnnounceRetryDelayMs(5)).toBe(8_000); // capped
  });

  it("scales the backoff sequence with a custom base delay", () => {
    // base=5000 → 5s, 10s, 20s, 40s (capped at max)
    expect(resolveAnnounceRetryDelayMs(1, { baseDelayMs: 5_000, maxDelayMs: 30_000 })).toBe(
      5_000,
    );
    expect(resolveAnnounceRetryDelayMs(2, { baseDelayMs: 5_000, maxDelayMs: 30_000 })).toBe(
      10_000,
    );
    expect(resolveAnnounceRetryDelayMs(3, { baseDelayMs: 5_000, maxDelayMs: 30_000 })).toBe(
      20_000,
    );
    expect(resolveAnnounceRetryDelayMs(4, { baseDelayMs: 5_000, maxDelayMs: 30_000 })).toBe(
      30_000,
    );
  });

  it("returns 0 when baseDelayMs is 0 (delay disabled)", () => {
    expect(resolveAnnounceRetryDelayMs(1, { baseDelayMs: 0 })).toBe(0);
    expect(resolveAnnounceRetryDelayMs(5, { baseDelayMs: 0 })).toBe(0);
  });

  it("ensures maxDelayMs is never less than baseDelayMs", () => {
    // If a user misconfigures with max < base, we floor max at base instead of returning a
    // smaller number that would invert the backoff.
    expect(resolveAnnounceRetryDelayMs(1, { baseDelayMs: 10_000, maxDelayMs: 1_000 })).toBe(
      10_000,
    );
  });
});

describe("#86488: resolveDeferredCleanupDecision honors configurable retry count", () => {
  const now = 2_000;
  const baseParams = {
    now,
    announceExpiryMs: 5 * 60_000,
    announceCompletionHardExpiryMs: 30 * 60_000,
    deferDescendantDelayMs: 1_000,
    resolveAnnounceRetryDelayMs: (retryCount: number) => retryCount * 1_000,
  };

  it("preserves default behavior (3 retries) when maxAnnounceRetryCount is the default", () => {
    // 2 attempts already made → next retry is attempt #3, which hits the 3-retry cap.
    const decision = resolveDeferredCleanupDecision({
      ...baseParams,
      entry: makeEntry({
        expectsCompletionMessage: true,
        delivery: { status: "pending", attemptCount: 2 },
      }),
      activeDescendantRuns: 0,
      maxAnnounceRetryCount: 3,
    });
    expect(decision).toEqual({ kind: "give-up", reason: "retry-limit", retryCount: 3 });
  });

  it("respects a higher maxAnnounceRetryCount (e.g. 5 retries for flaky channels)", () => {
    // With maxRetries=5, attempt #3 should still retry instead of giving up.
    const decision = resolveDeferredCleanupDecision({
      ...baseParams,
      entry: makeEntry({
        expectsCompletionMessage: true,
        delivery: { status: "pending", attemptCount: 2 },
      }),
      activeDescendantRuns: 0,
      maxAnnounceRetryCount: 5,
    });
    expect(decision).toEqual({ kind: "retry", retryCount: 3, resumeDelayMs: 3_000 });
  });

  it("gives up immediately when maxAnnounceRetryCount is 0 (retries disabled)", () => {
    const decision = resolveDeferredCleanupDecision({
      ...baseParams,
      entry: makeEntry({
        expectsCompletionMessage: false,
        delivery: { status: "pending", attemptCount: 0 },
      }),
      activeDescendantRuns: 0,
      maxAnnounceRetryCount: 0,
    });
    // First attempt (retryCount=1) already meets the 0 cap → retry-limit.
    expect(decision).toEqual({ kind: "give-up", reason: "retry-limit", retryCount: 1 });
  });

  it("passes the configured delay through to retry decisions", () => {
    const decision = resolveDeferredCleanupDecision({
      ...baseParams,
      entry: makeEntry({
        expectsCompletionMessage: true,
        delivery: { status: "pending", attemptCount: 0 },
      }),
      activeDescendantRuns: 0,
      maxAnnounceRetryCount: 3,
      resolveAnnounceRetryDelayMs: (retryCount) =>
        // Use the actual production helper with a custom 10s base — this is what
        // `agents.defaults.subagents.announceRetryBaseDelayMs: 10000` would deliver.
        resolveAnnounceRetryDelayMs(retryCount, { baseDelayMs: 10_000, maxDelayMs: 60_000 }),
    });
    expect(decision).toEqual({ kind: "retry", retryCount: 1, resumeDelayMs: 10_000 });
  });
});
