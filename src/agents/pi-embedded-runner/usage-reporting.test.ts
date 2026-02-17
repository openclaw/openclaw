import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "./run.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);

describe("runEmbeddedPiAgent usage reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports total usage from the last turn instead of accumulated total", async () => {
    // Simulate a multi-turn run result.
    // Turn 1: Input 100, Output 50. Total 150.
    // Turn 2: Input 150, Output 50. Total 200.

    // The accumulated usage (attemptUsage) will be the sum:
    // Input: 100 + 150 = 250 (Note: runEmbeddedAttempt actually returns accumulated usage)
    // Output: 50 + 50 = 100
    // Total: 150 + 200 = 350

    // The last assistant usage (lastAssistant.usage) will be Turn 2:
    // Input: 150, Output 50, Total 200.

    // We expect result.meta.agentMeta.usage.total to be 200 (last turn total).
    // The bug causes it to be 350 (accumulated total).

    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1", "Response 2"],
      lastAssistant: {
        usage: { input: 150, output: 50, total: 200 },
        stopReason: "end_turn",
      },
      attemptUsage: { input: 250, output: 100, total: 350 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    // Check usage in meta
    const usage = result.meta.agentMeta?.usage;
    expect(usage).toBeDefined();

    // Check if total matches the last turn's total (200)
    // If the bug exists, it will likely be 350
    expect(usage?.total).toBe(200);
  });
});
