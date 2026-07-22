// Codex tests cover native subagent task mirror plugin behavior.
/* eslint-disable max-lines -- mirrors the production lifecycle matrix in one suite */
import { describe, expect, it, vi } from "vitest";
import {
  codexNativeSubagentRunId,
  CodexNativeSubagentTaskMirror,
} from "./native-subagent-task-mirror.js";

type TaskLifecycleRuntime = ConstructorParameters<typeof CodexNativeSubagentTaskMirror>[1];

function createRuntime() {
  return {
    tryCreateRunningTaskRun: vi.fn((params) => ({ taskId: "task-native-subagent", ...params })),
    recordTaskRunProgressByRunId: vi.fn(() => []),
    finalizeTaskRunByRunId: vi.fn(() => []),
    recordExecutionReceipt: vi.fn((params) => ({
      taskId: "task-native-subagent",
      sequence: 1,
      ...params,
      recordedAt: params.recordedAt ?? Date.now(),
    })),
  } as unknown as TaskLifecycleRuntime;
}

describe("CodexNativeSubagentTaskMirror", () => {
  it("marks missing heartbeat and connector health stalled within one supervision period", async () => {
    vi.useFakeTimers();
    try {
      const runtime = createRuntime();
      const mirror = new CodexNativeSubagentTaskMirror(
        {
          parentThreadId: "parent-thread",
          requesterSessionKey: "agent:main:main",
          supervisionPeriodMs: 10,
          now: () => 50_000,
        },
        runtime,
      );
      mirror.handleNotification({
        method: "thread/started",
        params: {
          thread: {
            id: "child-thread",
            status: { type: "active", activeFlags: [] },
            source: {
              subAgent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } },
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(10);

      expect(runtime.recordExecutionReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "codex-thread:child-thread",
          kind: "relay_health",
          status: "error",
        }),
      );
      expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
        expect.objectContaining({ progressSummary: expect.stringContaining("Stalled") }),
      );
      mirror.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates one done-only task with an atomic native execution binding", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        agentId: "main",
        now: () => 20_000,
      },
      runtime,
    );
    mirror.handleNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          sessionId: "session-tree",
          preview: "write the Madrid wine script",
          createdAt: 10,
          status: { type: "active", activeFlags: [] },
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
                agent_nickname: "Poincare",
                agent_role: "worker",
              },
            },
          },
        },
      },
    });

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledWith({
      sourceId: "codex-thread:child-thread",
      agentId: "main",
      runId: "codex-thread:child-thread",
      label: "Poincare",
      task: "write the Madrid wine script",
      notifyPolicy: "done_only",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: 10_000,
      lastEventAt: 20_000,
      progressSummary: "Codex native subagent started.",
      detail: {
        executionBinding: {
          version: 1,
          runId: "codex-thread:child-thread",
          requesterSessionKey: "agent:main:main",
          endpoint: "codex-app-server:unknown",
          nativeThreadId: "child-thread",
          parentThreadId: "parent-thread",
        },
      },
    });
    expect(vi.mocked(runtime.tryCreateRunningTaskRun).mock.calls[0]?.[0]).not.toHaveProperty(
      "childSessionKey",
    );
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      lastEventAt: 20_000,
      progressSummary: "Codex native subagent is active.",
    });
  });

  it("records a redacted failed tool receipt without terminal or separate delivery state", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 21_000,
      },
      runtime,
    );
    mirror.handleNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          status: { type: "active", activeFlags: [] },
          source: {
            subAgent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } },
          },
        },
      },
    });

    mirror.handleNotification({
      method: "item/completed",
      params: {
        threadId: "child-thread",
        item: {
          type: "commandExecution",
          status: "failed",
          aggregatedOutput: "Authorization: Bearer raw-secret-value-1234567890",
        },
      },
    });

    expect(runtime.recordExecutionReceipt).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      kind: "tool_call",
      status: "error",
      recordedAt: 21_000,
      summary: "Codex tool item failed: commandExecution.",
      detail: { itemType: "commandExecution" },
    });
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(runtime.recordExecutionReceipt).mock.calls)).not.toContain(
      "raw-secret-value",
    );
    mirror.dispose();
  });

  it("records only structured artifact receipts from completed runtime items", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      { parentThreadId: "parent-thread", now: () => 22_000 },
      runtime,
    );
    mirror.handleNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          status: { type: "active", activeFlags: [] },
          source: {
            subAgent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } },
          },
        },
      },
    });

    mirror.handleNotification({
      method: "item/completed",
      params: {
        threadId: "child-thread",
        item: {
          type: "commandExecution",
          status: "completed",
          aggregatedOutput: "I created a PR and deployed green",
          executionReceipts: [
            { kind: "branch", status: "ok", detail: { name: "fix/receipt-gates" } },
            { kind: "diff", status: "ok", detail: { readable: true, files: 2 } },
          ],
        },
      },
    });

    expect(runtime.recordExecutionReceipt).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      kind: "branch",
      status: "ok",
      recordedAt: 22_000,
      summary: undefined,
      detail: { name: "fix/receipt-gates" },
    });
    expect(runtime.recordExecutionReceipt).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      kind: "diff",
      status: "ok",
      recordedAt: 22_000,
      summary: undefined,
      detail: { readable: true, files: 2 },
    });
    expect(runtime.recordExecutionReceipt).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pr" }),
    );
    expect(runtime.recordExecutionReceipt).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "deploy" }),
    );
    mirror.dispose();
  });

  it("stalls when relay lifecycle drops while connector notifications continue", () => {
    const runtime = createRuntime();
    let relayHealthy = true;
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        now: () => 23_000,
        isRelayHealthy: () => relayHealthy,
      },
      runtime,
    );
    mirror.handleNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          status: { type: "active", activeFlags: [] },
          source: {
            subAgent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } },
          },
        },
      },
    });
    relayHealthy = false;

    mirror.handleNotification({
      method: "turn/started",
      params: { threadId: "child-thread", turn: { id: "turn-2" } },
    });

    expect(runtime.recordExecutionReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        kind: "relay_health",
        status: "error",
      }),
    );
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        progressSummary: "Stalled: native hook relay registration is unavailable.",
      }),
    );
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    mirror.dispose();
  });

  it("ignores subagent threads spawned by a different parent thread", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
      },
      runtime,
    );
    mirror.handleNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "other-child",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "other-parent",
                depth: 1,
              },
            },
          },
        },
      },
    });

    expect(runtime.tryCreateRunningTaskRun).not.toHaveBeenCalled();
    expect(runtime.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("finalizes collab completion when no authoritative result path is available", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 44_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        item: {
          type: "collabAgentToolCall",
          tool: "spawn_agent",
          prompt: "inspect one thing",
          agentsStates: {
            "child-thread": {
              status: "completed",
              message: "done",
            },
          },
        },
      },
    });

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      status: "succeeded",
      endedAt: 44_000,
      lastEventAt: 44_000,
      progressSummary: "done",
      terminalSummary: "done",
    });
  });

  it("deduplicates repeated thread-started notifications for the same child thread", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
      },
      runtime,
    );
    const notification = {
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
              },
            },
          },
        },
      },
    } as const;

    mirror.handleNotification(notification);
    mirror.handleNotification(notification);

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledTimes(1);
  });

  it("maps Codex thread status changes onto the mirrored task run", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 30_000,
      },
      runtime,
    );
    mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });
    mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "failed-child",
        status: { type: "systemError" },
      },
    });

    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: codexNativeSubagentRunId("child-thread"),
      lastEventAt: 30_000,
      progressSummary: "Codex native subagent is idle.",
    });
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(1);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: codexNativeSubagentRunId("failed-child"),
      status: "failed",
      endedAt: 30_000,
      lastEventAt: 30_000,
      error: "Codex app-server reported a system error for the native subagent thread.",
      progressSummary: "Codex native subagent hit a system error.",
      terminalSummary: "Codex native subagent failed.",
    });
  });

  it("keeps recoverable system errors non-terminal when authoritative recovery is expected", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 35_000,
      },
      runtime,
    );
    mirror.markAuthoritativeCompletionExpected("child-thread");

    mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });
    mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "systemError" },
      },
    });
    mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "active", activeFlags: [] },
      },
    });

    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenNthCalledWith(1, {
      runId: codexNativeSubagentRunId("child-thread"),
      lastEventAt: 35_000,
      progressSummary: "Codex native subagent is idle.",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenNthCalledWith(2, {
      runId: codexNativeSubagentRunId("child-thread"),
      lastEventAt: 35_000,
      progressSummary: "Stalled: Codex app-server reported a system error.",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenNthCalledWith(3, {
      runId: codexNativeSubagentRunId("child-thread"),
      lastEventAt: 35_000,
      progressSummary: "Codex native subagent is active.",
    });
  });

  it("creates and updates tasks from Codex collab agent item state", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 40_000,
      },
      runtime,
    );
    mirror.markAuthoritativeCompletionExpected("child-thread");
    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "write the proof file",
          agentsStates: {
            "child-thread": {
              status: "pendingInit",
              message: null,
            },
          },
        },
      },
    });
    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          senderThreadId: "parent-thread",
          receiverThreadIds: [],
          agentsStates: {
            "child-thread": {
              status: "completed",
              message: "done",
            },
          },
        },
      },
    });

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledWith({
      sourceId: "codex-thread:child-thread",
      runId: "codex-thread:child-thread",
      label: "Codex subagent",
      task: "write the proof file",
      notifyPolicy: "done_only",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: 40_000,
      lastEventAt: 40_000,
      progressSummary: "Codex native subagent spawned.",
      detail: {
        executionBinding: {
          version: 1,
          runId: "codex-thread:child-thread",
          requesterSessionKey: "agent:main:main",
          endpoint: "codex-app-server:unknown",
          nativeThreadId: "child-thread",
          parentThreadId: "parent-thread",
        },
      },
    });
    expect(vi.mocked(runtime.tryCreateRunningTaskRun).mock.calls[0]?.[0]).not.toHaveProperty(
      "childSessionKey",
    );
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      lastEventAt: 40_000,
      progressSummary: "Codex native subagent is initializing.",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      lastEventAt: 40_000,
      progressSummary: "done",
    });
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("mirrors Codex multi-agent V2 activity lifecycle", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        agentId: "main",
        now: () => 41_000,
      },
      runtime,
    );
    for (const kind of ["started", "interacted", "interrupted"] as const) {
      for (const method of ["item/started", "item/completed"] as const) {
        mirror.handleNotification({
          method,
          params: {
            threadId: "parent-thread",
            item: {
              type: "subAgentActivity",
              id: `activity-${kind}`,
              kind,
              agentThreadId: "child-v2",
              agentPath: "/root/researcher",
            },
          },
        });
      }
    }
    for (const threadId of ["parent-thread", "other-parent"]) {
      mirror.handleNotification({
        method: "item/completed",
        params: {
          threadId,
          item: {
            type: "subAgentActivity",
            kind: "started",
            agentThreadId: threadId === "parent-thread" ? "child-v2" : "other-child",
            agentPath: "/root/researcher",
          },
        },
      });
    }

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledTimes(1);
    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledWith({
      sourceId: "codex-thread:child-v2",
      agentId: "main",
      runId: "codex-thread:child-v2",
      label: "Codex subagent",
      task: "Codex native subagent /root/researcher",
      notifyPolicy: "done_only",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: 41_000,
      lastEventAt: 41_000,
      progressSummary: "Codex native subagent started.",
      detail: {
        executionBinding: {
          version: 1,
          runId: "codex-thread:child-v2",
          requesterSessionKey: "agent:main:main",
          endpoint: "codex-app-server:unknown",
          nativeThreadId: "child-v2",
          parentThreadId: "parent-thread",
        },
      },
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-v2",
      lastEventAt: 41_000,
      progressSummary: "Codex native subagent received more input.",
    });
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-v2",
      status: "cancelled",
      endedAt: 41_000,
      lastEventAt: 41_000,
      error: "Codex native subagent was interrupted.",
      progressSummary: "Codex native subagent was interrupted.",
      terminalSummary: "Codex native subagent was interrupted.",
    });
  });

  it("uses the notification thread id when collab agent items omit sender thread id", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 42_000,
      },
      runtime,
    );
    mirror.handleNotification({
      method: "item/started",
      params: {
        threadId: "parent-thread",
        item: {
          type: "collabAgentToolCall",
          tool: "spawn_agent",
          receiverThreadIds: ["child-thread"],
          prompt: "inspect one thing",
        },
      },
    });

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        task: "inspect one thing",
      }),
    );
  });

  it("creates spawn tasks from collab agent states when receiver thread ids are absent", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 43_000,
      },
      runtime,
    );
    mirror.markAuthoritativeCompletionExpected("child-thread");

    mirror.handleNotification({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        item: {
          type: "collabAgentToolCall",
          tool: "spawn_agent",
          prompt: "inspect one thing",
          agentsStates: {
            "child-thread": {
              status: "completed",
              message: "done",
            },
          },
        },
      },
    });

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        task: "inspect one thing",
      }),
    );
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        progressSummary: "done",
      }),
    );
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("finalizes stale collab agent state from the blocked tool call status", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 45_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "blocked",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "read cwd",
          agentsStates: {
            "child-thread": {
              status: "pendingInit",
              message: "Native hook relay unavailable",
            },
          },
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunId).not.toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      lastEventAt: 45_000,
      progressSummary: "Native hook relay unavailable",
    });
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      status: "succeeded",
      endedAt: 45_000,
      lastEventAt: 45_000,
      progressSummary: "Native hook relay unavailable",
      terminalSummary: "Native hook relay unavailable",
      terminalOutcome: "blocked",
    });
  });

  it("does not treat completed tool calls as completed subagents", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 46_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "read cwd",
          agentsStates: {
            "child-thread": {
              status: "pendingInit",
              message: null,
            },
          },
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      lastEventAt: 46_000,
      progressSummary: "Codex native subagent is initializing.",
    });
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("does not treat failed non-spawn tool calls as failed subagents", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 47_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          status: "failed",
          senderThreadId: "parent-thread",
          receiverThreadIds: [],
          agentsStates: {
            "child-thread": {
              status: "running",
              message: "wait timed out",
            },
          },
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      lastEventAt: 47_000,
      progressSummary: "wait timed out",
    });
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("records completed collab agent and idle thread states as progress only", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 50_000,
      },
      runtime,
    );
    mirror.markAuthoritativeCompletionExpected("child-thread");

    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "write the proof file",
          agentsStates: {
            "child-thread": {
              status: "completed",
              message: "No user task is specified.",
            },
          },
        },
      },
    });
    mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });

    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledTimes(1);
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      lastEventAt: 50_000,
      progressSummary: "No user task is specified.",
    });
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("keeps terminal collab failures from rewriting authoritative completion", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 52_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "write the proof file",
        },
      },
    });
    mirror.markAuthoritativeCompletion("child-thread");
    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          senderThreadId: "parent-thread",
          agentsStates: {
            "child-thread": {
              status: "errored",
              message: "later turn failed",
            },
          },
        },
      },
    });

    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("lets terminal collab agent state finalize after an earlier idle thread status", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 55_000,
      },
      runtime,
    );

    mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });
    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "failed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "read cwd",
          agentsStates: {
            "child-thread": {
              status: "pendingInit",
              message: "Native hook relay unavailable",
            },
          },
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      lastEventAt: 55_000,
      progressSummary: "Codex native subagent is idle.",
    });
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(1);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      status: "failed",
      endedAt: 55_000,
      lastEventAt: 55_000,
      error: "Native hook relay unavailable",
      progressSummary: "Native hook relay unavailable",
      terminalSummary: "Native hook relay unavailable",
    });
  });

  it("normalizes collab agent status spelling from alternate event surfaces", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 60_000,
      },
      runtime,
    );
    mirror.markAuthoritativeCompletionExpected("child-thread");

    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          agentsStates: {
            "child-thread": {
              status: "pending_init",
              message: null,
            },
          },
        },
      },
    });
    mirror.handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          senderThreadId: "parent-thread",
          agentsStates: {
            "child-thread": {
              status: "success",
              message: "done",
            },
          },
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      lastEventAt: 60_000,
      progressSummary: "Codex native subagent is initializing.",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      lastEventAt: 60_000,
      progressSummary: "done",
    });
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });
});
