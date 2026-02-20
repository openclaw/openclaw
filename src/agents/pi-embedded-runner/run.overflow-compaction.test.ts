import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import { UsagePreflightError } from "./usage-preflight.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedCompactDirect = vi.mocked(compactEmbeddedPiSessionDirect);

describe("runEmbeddedPiAgent overflow compaction trigger routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes trigger=overflow when retrying compaction after context overflow", async () => {
    const overflowError = new Error("request_too_large: Request size exceeds model context window");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      },
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

  it("returns a user-facing error for usage preflight blocks without compaction", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: new UsagePreflightError(
          {
            providerId: "openai-codex",
            blocked: true,
            warning: true,
            estimatedPromptTokens: 512,
            remainingPercent: 1,
            windowLabel: "3h",
          },
          "Usage guard: request blocked to avoid hitting openai-codex limits.",
        ),
      }),
    );

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-preflight",
    });

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Usage guard");
    expect(mockedCompactDirect).not.toHaveBeenCalled();
  });
});
