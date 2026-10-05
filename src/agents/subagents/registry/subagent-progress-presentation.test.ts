import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "../../../channels/progress-draft-compositor.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  projectSubagentProgressActivity,
  projectSubagentProgressState,
} from "./subagent-progress-presentation.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function event(data: Record<string, unknown>, stream = "item"): AgentEventPayload {
  return { runId: "child", seq: 1, ts: 0, stream, lifecycleGeneration: "current", data };
}
function child(): SubagentRunRecord {
  return {
    runId: "child",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "private task",
    taskName: "Delegated verification",
    cleanup: "keep",
    createdAt: 0,
    execution: { status: "running" },
  };
}

describe("private child progress presentation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("renders changing prepared operation outcomes without child commands or prose", async () => {
    const compositor = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { toolProgress: true } } },
      mode: "progress",
      active: true,
      preparedItems: true,
      reasoningGate: false,
      seed: "test",
      initialSnapshot: { lines: [], statusHeadline: "Verifying the request" },
    });
    try {
      for (const status of ["running", "completed"] as const) {
        const item = projectSubagentProgressActivity(
          event({
            kind: "tool",
            name: "exec",
            status,
            title: "PRIVATE_TITLE",
            args: { command: "PRIVATE_COMMAND" },
            summary: "PRIVATE_RESULT",
            progressText: "PRIVATE_REASONING",
          }),
          "current",
          "child:tool",
        );
        expect(item).toEqual({
          itemId: "child:tool",
          kind: "tool",
          name: "exec",
          phase: status === "running" ? "update" : "end",
          status,
        });
        await compositor.pushItemEvent(item!);
        expect(compositor.getText()).toContain("Exec");
        expect(compositor.getSnapshot().lines).toEqual([expect.objectContaining({ status })]);
        if (status === "running") {
          expect(compositor.getText()).toContain("running");
        } else {
          expect(compositor.getText()).not.toContain("running");
        }
        expect(compositor.getText()).not.toContain("PRIVATE_");
      }
      expect(compositor.getSnapshot().lines).toHaveLength(1);
    } finally {
      compositor.cancel();
    }
  });

  it.each([
    event({ kind: "analysis", name: "exec", status: "running" }),
    event({ kind: "tool", name: "exec", status: "running", hideFromChannelProgress: true }),
    event({ kind: "tool", name: "exec", status: "running", suppressChannelProgress: true }),
    event({ kind: "tool", name: "exec", status: "unknown" }),
    event({ phase: "start", name: "exec", args: { command: "private" } }, "tool"),
    event({ kind: "tool", name: "private\nprose", status: "running" }),
    { ...event({ kind: "tool", name: "exec", status: "running" }), lifecycleGeneration: "stale" },
  ])("does not project private, hidden, raw or stale activity %#", (input) => {
    expect(projectSubagentProgressActivity(input, "current", "child:tool")).toBeUndefined();
  });

  it("preserves the tool-progress opt-out", async () => {
    const compositor = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { toolProgress: false } } },
      mode: "progress",
      active: true,
      preparedItems: true,
      reasoningGate: false,
      seed: "quiet",
      initialSnapshot: { lines: [], statusHeadline: "Verifying the request" },
    });
    try {
      await compositor.pushItemEvent(
        projectSubagentProgressActivity(
          event({ kind: "tool", name: "exec", status: "running" }),
          "current",
          "child:tool",
        )!,
      );
      expect(compositor.getText()).not.toContain("command");
      expect(compositor.getSnapshot().lines).toHaveLength(0);
    } finally {
      compositor.cancel();
    }
  });

  it("distinguishes a paused child from failure and completed child", () => {
    const entry = child();
    expect(projectSubagentProgressState(entry)).toMatchObject({
      title: "Delegated verification",
      status: "running",
    });
    entry.execution = { status: "terminal", endedAt: 1 };
    entry.pauseReason = "sessions_yield";
    expect(projectSubagentProgressState(entry)).toMatchObject({
      phase: "update",
      status: undefined,
      summary: "waiting",
    });
    entry.pauseReason = undefined;
    expect(projectSubagentProgressState(entry)).toMatchObject({
      status: undefined,
      summary: "outcome unknown",
    });
    entry.execution.outcome = { status: "error", error: "private error" };
    expect(projectSubagentProgressState(entry)).toMatchObject({ phase: "end", status: "failed" });
    entry.execution.outcome = { status: "ok" };
    expect(projectSubagentProgressState(entry)).toMatchObject({
      phase: "end",
      status: "completed",
    });
  });
});
