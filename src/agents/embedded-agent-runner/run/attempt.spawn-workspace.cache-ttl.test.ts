// Coverage for cache-TTL session entries after embedded attempts.
import { describe, expect, it, vi } from "vitest";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { appendAttemptCacheTtlIfNeeded } from "./attempt-thread-helpers.js";

const ATTEMPT_CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

describe("runEmbeddedAttempt cache-ttl tracking after compaction", () => {
  it.each([true, false])("uses the resolved route for marker eligibility %s", (eligible) => {
    const sessionManager = { appendCustomEntry: vi.fn() };
    const isCacheTtlEligibleProvider = vi.fn(() => eligible);
    const modelRoute = { baseUrl: "https://proxy.example/v1", supportsPromptCacheKey: eligible };
    const appended = appendAttemptCacheTtlIfNeeded({
      sessionManager,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai-responses",
      modelRoute,
      isCacheTtlEligibleProvider,
      now: 123,
    });
    expect(isCacheTtlEligibleProvider).toHaveBeenCalledExactlyOnceWith(
      "openai",
      "gpt-4o",
      "openai-responses",
      modelRoute,
    );
    expect(appended).toBe(eligible);
    expect(sessionManager.appendCustomEntry).toHaveBeenCalledTimes(eligible ? 1 : 0);
  });

  it("does not inspect route eligibility when pruning is off", () => {
    const isCacheTtlEligibleProvider = vi.fn(() => true);
    const sessionManager = { appendCustomEntry: vi.fn() };
    expect(
      appendAttemptCacheTtlIfNeeded({
        sessionManager,
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
        provider: "openai",
        modelId: "gpt-4o",
        isCacheTtlEligibleProvider,
      }),
    ).toBe(false);
    expect(isCacheTtlEligibleProvider).not.toHaveBeenCalled();
    expect(sessionManager.appendCustomEntry).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "completed", timedOutDuringCompaction: false, compactionOccurredThisAttempt: true },
    { reason: "timed out", timedOutDuringCompaction: true, compactionOccurredThisAttempt: false },
  ])("skips cache-ttl append when compaction $reason", (compaction) => {
    // Completed or interrupted compaction cannot establish cache continuity for
    // the old prompt, so neither case may record a fresh cache touch.
    const sessionManager = {
      appendCustomEntry: vi.fn(),
    };
    const appended = appendAttemptCacheTtlIfNeeded({
      sessionManager,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
      timedOutDuringCompaction: compaction.timedOutDuringCompaction,
      compactionOccurredThisAttempt: compaction.compactionOccurredThisAttempt,
      config: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      modelApi: "anthropic-messages",
      isCacheTtlEligibleProvider: () => true,
      now: 123,
    });

    expect(appended).toBe(false);
    expect(sessionManager.appendCustomEntry).not.toHaveBeenCalled();
  });

  it("appends cache-ttl when no compaction completed during the attempt", () => {
    const sessionManager = {
      appendCustomEntry: vi.fn(),
    };
    const appended = appendAttemptCacheTtlIfNeeded({
      sessionManager,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      config: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      modelApi: "anthropic-messages",
      isCacheTtlEligibleProvider: () => true,
      now: 123,
    });

    expect(appended).toBe(true);
    expect(sessionManager.appendCustomEntry).toHaveBeenCalledWith(ATTEMPT_CACHE_TTL_CUSTOM_TYPE, {
      timestamp: 123,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      prunedToolResults: [],
      ambiguousToolResultBaseKeys: [],
      frozenToolResults: [],
    });
  });
});
