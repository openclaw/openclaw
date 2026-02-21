import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickFallbackThinkingLevel } from "../pi-embedded-helpers.js";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult, mockOverflowRetrySuccess } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import {
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSession,
} from "./tool-result-truncation.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedCompactDirect = vi.mocked(compactEmbeddedPiSessionDirect);
const mockedSessionLikelyHasOversizedToolResults = vi.mocked(sessionLikelyHasOversizedToolResults);
const mockedTruncateOversizedToolResultsInSession = vi.mocked(
  truncateOversizedToolResultsInSession,
);
const mockedPickFallbackThinkingLevel = vi.mocked(pickFallbackThinkingLevel);

describe("runEmbeddedPiAgent overflow compaction trigger routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes trigger=overflow when retrying compaction after context overflow", async () => {
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "overflow",
        authProfileId: "test-profile",
      }),
    );
  });

  it("does not reset compaction attempt budget after successful tool-result truncation", async () => {
    const overflowError = new Error("request_too_large: Request size exceeds model context window");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: overflowError,
          messagesSnapshot: [
            {
              role: "assistant",
              content: "big tool output",
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          ],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      // Keep one extra mocked response so legacy reset behavior does not crash the test.
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect
      .mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason: "nothing to compact",
      })
      .mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: { summary: "Compacted 2", firstKeptEntryId: "entry-5", tokensBefore: 160000 },
      })
      .mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: { summary: "Compacted 3", firstKeptEntryId: "entry-7", tokensBefore: 140000 },
      });

    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 1,
    });

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(3);
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.meta.error?.kind).toBe("context_overflow");
  });

  it("returns retry_limit when repeated retries never converge", async () => {
    mockedRunEmbeddedAttempt.mockReset();
    mockedCompactDirect.mockReset();
    mockedPickFallbackThinkingLevel.mockReset();
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({ promptError: new Error("unsupported reasoning mode") }),
    );
    mockedPickFallbackThinkingLevel.mockReturnValue("low");

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });
});
