import { describe, expect, it, vi } from "vitest";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { appendAttemptCacheTtlIfNeeded } from "./attempt-thread-helpers.js";

describe("runEmbeddedAttempt cache-ttl tracking after compaction", () => {
  it.each(["completed", "timed out", "none"])(
    "records cache continuity after compaction: %s",
    (compaction) => {
      const sessionManager = { appendCustomEntry: vi.fn() };
      const appended = appendAttemptCacheTtlIfNeeded({
        sessionManager,
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
        timedOutDuringCompaction: compaction === "timed out",
        compactionOccurredThisAttempt: compaction === "completed",
        config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        modelApi: "anthropic-messages",
        isCacheTtlEligibleProvider: () => true,
        now: 123,
      });
      expect(appended).toBe(compaction === "none");
      if (compaction !== "none") {
        expect(sessionManager.appendCustomEntry).not.toHaveBeenCalled();
        return;
      }
      expect(sessionManager.appendCustomEntry).toHaveBeenCalledWith("openclaw.cache-ttl", {
        timestamp: 123,
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        prunedToolResults: [],
        ambiguousToolResultBaseKeys: [],
        frozenToolResults: [],
      });
    },
  );
});
