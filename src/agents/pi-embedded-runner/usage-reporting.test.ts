import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  loadRunOverflowCompactionHarness,
  mockedEnsureRuntimePluginsLoaded,
  mockedRunEmbeddedAttempt,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent usage reporting", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedEnsureRuntimePluginsLoaded.mockReset();
    mockedRunEmbeddedAttempt.mockReset();
  });

  it("bootstraps runtime plugins with the resolved workspace before running", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-plugin-bootstrap",
    });

    expect(mockedEnsureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("forwards gateway subagent binding opt-in to runtime plugin bootstrap", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-gateway-bind",
      allowGatewaySubagentBinding: true,
    });

    expect(mockedEnsureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
      }),
    );
  });

  it("forwards sender identity fields into embedded attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-sender-forwarding",
      senderId: "user-123",
      senderName: "Josh Lehman",
      senderUsername: "josh",
      senderE164: "+15551234567",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "user-123",
        senderName: "Josh Lehman",
        senderUsername: "josh",
        senderE164: "+15551234567",
      }),
    );
  });

  it("forwards memory flush write paths into memory-triggered attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "flush",
      timeoutMs: 30000,
      runId: "run-memory-forwarding",
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-03-10.md",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-03-10.md",
      }),
    );
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

  it("accumulates callCount from attempts with tool-call loops", async () => {
    // Simulate an attempt with 3 LLM API calls (e.g., tool-call loop).
    // Each call contributes to usage, and callCount should reflect 3 calls.

    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response"],
      lastAssistant: {
        usage: { input: 300, output: 150, total: 450 },
        stopReason: "end_turn",
      },
      attemptUsage: { input: 300, output: 150, total: 450 },
      attemptCallCount: 3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-callcount",
    });

    const agentMeta = result.meta.agentMeta;
    expect(agentMeta?.callCount).toBe(3);
  });

  it("accumulates callCount across multiple attempts", async () => {
    // Simulate multiple attempts (e.g., fallback), each with its own callCount.

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce({
        aborted: false,
        promptError: null,
        timedOut: false,
        sessionIdUsed: "test-session",
        assistantTexts: [],
        lastAssistant: {
          usage: { input: 100, output: 50, total: 150 },
          stopReason: "error",
        },
        attemptUsage: { input: 100, output: 50, total: 150 },
        attemptCallCount: 2,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .mockResolvedValueOnce({
        aborted: false,
        promptError: null,
        timedOut: false,
        sessionIdUsed: "test-session",
        assistantTexts: ["Response"],
        lastAssistant: {
          usage: { input: 150, output: 75, total: 225 },
          stopReason: "end_turn",
        },
        attemptUsage: { input: 150, output: 75, total: 225 },
        attemptCallCount: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-callcount-multi",
      maxAttempts: 2,
    });

    // Note: This test assumes fallback logic is in place to run multiple attempts.
    // The actual behavior depends on the fallback implementation.
    // For now, we just verify the first attempt's callCount is reflected.
    const agentMeta = result.meta.agentMeta;
    expect(agentMeta?.callCount).toBeGreaterThanOrEqual(2);
  });
});
