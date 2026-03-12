import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finalizeAgentRunTrace,
  finishAgentRunTraceRetry,
  finishAgentRunTraceTool,
  getAgentRunTraceTimeline,
  recordAgentRunTraceModelOutput,
  resetAgentRunTraceForTest,
  startAgentRunTraceModelTurn,
  startAgentRunTraceTool,
} from "./agent-run-trace.js";

describe("agent run trace", () => {
  beforeEach(() => {
    resetAgentRunTraceForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records plan -> tool -> observation -> replan -> ok", () => {
    startAgentRunTraceModelTurn({
      runId: "run-1",
      sessionKey: "agent:main",
      attempt: 1,
      at: 100,
      provider: "openai",
      model: "gpt-5",
    });
    recordAgentRunTraceModelOutput({
      runId: "run-1",
      usage: { input: 10, output: 20, total: 30 },
      costUsd: 0.0012,
      stopReason: "tool_calls",
      provider: "openai",
      model: "gpt-5",
    });
    startAgentRunTraceTool({
      runId: "run-1",
      sessionKey: "agent:main",
      attempt: 1,
      at: 150,
      toolName: "read",
      toolCallId: "tool-1",
    });
    finishAgentRunTraceTool({
      runId: "run-1",
      sessionKey: "agent:main",
      attempt: 1,
      toolCallId: "tool-1",
      toolName: "read",
      status: "ok",
      at: 210,
    });
    startAgentRunTraceModelTurn({
      runId: "run-1",
      sessionKey: "agent:main",
      attempt: 1,
      at: 240,
      provider: "openai",
      model: "gpt-5",
    });
    recordAgentRunTraceModelOutput({
      runId: "run-1",
      usage: { input: 15, output: 8, total: 23 },
      costUsd: 0.0008,
      stopReason: "end_turn",
      provider: "openai",
      model: "gpt-5",
    });
    finalizeAgentRunTrace({
      runId: "run-1",
      sessionKey: "agent:main",
      status: "ok",
      at: 300,
    });

    const timeline = getAgentRunTraceTimeline("run-1");
    expect(timeline?.status).toBe("ok");
    expect(timeline?.attemptCount).toBe(1);
    expect(timeline?.spans.map((span) => span.stage)).toEqual([
      "plan",
      "tool",
      "observation",
      "replan",
    ]);
    expect(timeline?.spans.map((span) => span.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(timeline?.spans[0]?.usage?.total).toBe(30);
    expect(timeline?.spans[3]?.usage?.total).toBe(23);
    expect(timeline?.totalCostUsd).toBeCloseTo(0.002, 6);
  });

  it("records an implicit silent replan when a new tool starts directly from observation", () => {
    startAgentRunTraceModelTurn({
      runId: "run-2",
      attempt: 1,
      at: 100,
    });
    startAgentRunTraceTool({
      runId: "run-2",
      attempt: 1,
      at: 120,
      toolName: "fetch",
      toolCallId: "tool-a",
    });
    finishAgentRunTraceTool({
      runId: "run-2",
      attempt: 1,
      toolCallId: "tool-a",
      status: "ok",
      at: 150,
    });
    startAgentRunTraceTool({
      runId: "run-2",
      attempt: 1,
      at: 180,
      toolName: "write",
      toolCallId: "tool-b",
    });

    const timeline = getAgentRunTraceTimeline("run-2");
    expect(timeline?.spans.map((span) => span.stage)).toEqual([
      "plan",
      "tool",
      "observation",
      "replan",
      "tool",
    ]);
    expect(timeline?.spans[3]).toMatchObject({
      status: "ok",
      silent: true,
      durationMs: 0,
    });
  });

  it("keeps the run active across retries and closes the failed model turn", () => {
    startAgentRunTraceModelTurn({
      runId: "run-3",
      attempt: 1,
      at: 100,
      provider: "anthropic",
      model: "claude",
    });
    finishAgentRunTraceRetry({
      runId: "run-3",
      status: "error",
      at: 130,
      failureReason: "billing",
      error: "credits exhausted",
    });
    startAgentRunTraceModelTurn({
      runId: "run-3",
      attempt: 2,
      at: 150,
      provider: "openai",
      model: "gpt-5",
    });

    const timeline = getAgentRunTraceTimeline("run-3");
    expect(timeline?.status).toBe("running");
    expect(timeline?.attemptCount).toBe(2);
    expect(timeline?.spans[0]).toMatchObject({
      stage: "plan",
      status: "error",
      failureReason: "billing",
      error: "credits exhausted",
      provider: "anthropic",
      model: "claude",
    });
    expect(timeline?.spans[1]).toMatchObject({
      stage: "plan",
      status: "running",
      provider: "openai",
      model: "gpt-5",
    });
  });

  it("starts a new retry attempt with plan after prior tool activity", () => {
    startAgentRunTraceModelTurn({
      runId: "run-4",
      attempt: 1,
      at: 100,
    });
    startAgentRunTraceTool({
      runId: "run-4",
      attempt: 1,
      at: 120,
      toolName: "fetch",
      toolCallId: "tool-1",
    });
    finishAgentRunTraceTool({
      runId: "run-4",
      attempt: 1,
      toolCallId: "tool-1",
      status: "ok",
      at: 150,
    });
    finishAgentRunTraceRetry({
      runId: "run-4",
      status: "error",
      at: 180,
      failureReason: "tool_retry",
      error: "retry requested",
    });
    startAgentRunTraceModelTurn({
      runId: "run-4",
      attempt: 2,
      at: 210,
    });

    const timeline = getAgentRunTraceTimeline("run-4");
    expect(timeline?.attemptCount).toBe(2);
    expect(timeline?.spans.map((span) => span.stage)).toEqual([
      "plan",
      "tool",
      "observation",
      "plan",
    ]);
    expect(timeline?.spans[2]).toMatchObject({
      status: "error",
      failureReason: "tool_retry",
      error: "retry requested",
    });
    expect(timeline?.spans[3]).toMatchObject({
      attempt: 2,
      stage: "plan",
      status: "running",
    });
  });

  it("prunes stale running timelines after the extended retention window", () => {
    startAgentRunTraceModelTurn({
      runId: "run-5",
      attempt: 1,
      at: 100,
    });

    vi.advanceTimersByTime(29 * 60_000);
    expect(getAgentRunTraceTimeline("run-5")?.status).toBe("running");

    vi.advanceTimersByTime(2 * 60_000);
    expect(getAgentRunTraceTimeline("run-5")).toBeUndefined();
  });
});
