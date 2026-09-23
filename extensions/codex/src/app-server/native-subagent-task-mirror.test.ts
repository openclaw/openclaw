// Codex tests cover native subagent task mirror plugin behavior.
import {
  captureAgentHarnessTaskAssignment,
  type AgentHarnessTaskRecord,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { describe, expect, it, vi } from "vitest";
import { createRecordedRuntime, taskRecord } from "./native-subagent-monitor.test-support.js";
import { codexNativeSubagentRunId } from "./native-subagent-task-ids.js";
import { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";

type TaskLifecycleRuntime = ConstructorParameters<typeof CodexNativeSubagentTaskMirror>[1];

function createRuntime() {
  return {
    tryCreateRunningTaskRun: vi.fn((params) => ({ taskId: "task-native-subagent", ...params })),
    recordTaskRunProgressByRunId: vi.fn(() => []),
    finalizeTaskRunByRunId: vi.fn(() => []),
    listTaskRecords: vi.fn(() => []),
  } as unknown as TaskLifecycleRuntime;
}

function expectedAssignment(runtime: TaskLifecycleRuntime) {
  return captureAgentHarnessTaskAssignment(
    vi.mocked(runtime.tryCreateRunningTaskRun).mock.results[0]!.value,
  );
}

describe("CodexNativeSubagentTaskMirror", () => {
  it("creates a silent task-registry task for a native Codex subagent thread", () => {
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
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: 10_000,
      lastEventAt: 20_000,
      progressSummary: "Subagent started.",
    });
    expect(vi.mocked(runtime.tryCreateRunningTaskRun).mock.calls[0]?.[0]).not.toHaveProperty(
      "childSessionKey",
    );
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: expectedAssignment(runtime),
      lastEventAt: 20_000,
      progressSummary: "Subagent is active.",
    });
  });

  it.each([true, false])(
    "preserves creation-time history ownership through progress, completion and recovery (stamped=%s)",
    (stamped) => {
      const runtime = createRuntime();
      const historyOwner = {
        parentThreadId: "parent-thread",
        sessionId: "original-session",
        connectionFingerprint: "original-connection",
      };
      const initial = new CodexNativeSubagentTaskMirror(
        { parentThreadId: "parent-thread", ...(stamped ? { historyOwner } : {}) },
        runtime,
      );
      const notify = (mirror: CodexNativeSubagentTaskMirror, status: string) =>
        mirror.handleNotification({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            item: {
              type: "collabAgentToolCall",
              tool: "spawn_agent",
              prompt: "Inspect one item",
              agentsStates: { "child-thread": { status, message: "Lifecycle update" } },
            },
          },
        });
      notify(initial, "running");
      const originalTask = vi.mocked(runtime.tryCreateRunningTaskRun).mock.results[0]!.value;
      expect(originalTask.detail).toEqual(stamped ? { nativeHistory: historyOwner } : undefined);
      vi.mocked(runtime.listTaskRecords).mockReturnValue([originalTask]);
      const recovered = new CodexNativeSubagentTaskMirror(
        {
          parentThreadId: "parent-thread",
          historyOwner: {
            ...historyOwner,
            sessionId: "replacement-session",
            connectionFingerprint: "replacement-connection",
          },
        },
        runtime,
      );
      notify(recovered, "running");
      notify(recovered, "completed");
      expect(vi.mocked(runtime.tryCreateRunningTaskRun).mock.calls[1]![0]).not.toHaveProperty(
        "detail",
      );
      expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalled();
      expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
      for (const [update] of [
        ...vi.mocked(runtime.recordTaskRunProgressByRunId).mock.calls,
        ...vi.mocked(runtime.finalizeTaskRunByRunId).mock.calls,
      ]) {
        expect(update).not.toHaveProperty("detail");
      }
      expect(originalTask.detail).toEqual(stamped ? { nativeHistory: historyOwner } : undefined);
    },
  );

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
      progressSummary: "Subagent is idle.",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenNthCalledWith(2, {
      runId: codexNativeSubagentRunId("child-thread"),
      lastEventAt: 35_000,
      progressSummary: "Subagent hit a system error; awaiting recovery.",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenNthCalledWith(3, {
      runId: codexNativeSubagentRunId("child-thread"),
      lastEventAt: 35_000,
      progressSummary: "Subagent is active.",
    });
  });

  it("mirrors spawn state without projecting a later wait snapshot", () => {
    const runtime = createRuntime();
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        now: () => 40_000,
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
      label: "Subagent",
      task: "write the proof file",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: 40_000,
      lastEventAt: 40_000,
      progressSummary: "Subagent spawned.",
    });
    expect(vi.mocked(runtime.tryCreateRunningTaskRun).mock.calls[0]?.[0]).not.toHaveProperty(
      "childSessionKey",
    );
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: expectedAssignment(runtime),
      lastEventAt: 40_000,
      progressSummary: "Subagent is initializing.",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledTimes(1);
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
      label: "Subagent",
      task: "Subagent /root/researcher",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: 41_000,
      lastEventAt: 41_000,
      progressSummary: "Subagent started.",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-v2",
      expectedTask: expectedAssignment(runtime),
      lastEventAt: 41_000,
      progressSummary: "Subagent received more input.",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-v2",
      expectedTask: expectedAssignment(runtime),
      lastEventAt: 41_000,
      progressSummary: "Subagent was interrupted.",
    });
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
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
      expectedTask: expectedAssignment(runtime),
      lastEventAt: 45_000,
      progressSummary: "Native hook relay unavailable",
    });
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: expectedAssignment(runtime),
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
      expectedTask: expectedAssignment(runtime),
      lastEventAt: 46_000,
      progressSummary: "Subagent is initializing.",
    });
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("does not project a failed wait call onto a subagent lifecycle", () => {
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

    expect(runtime.tryCreateRunningTaskRun).not.toHaveBeenCalled();
    expect(runtime.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
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
      expectedTask: expectedAssignment(runtime),
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
          tool: "spawnAgent",
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
      progressSummary: "Subagent is idle.",
    });
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(1);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: expectedAssignment(runtime),
      status: "failed",
      endedAt: 55_000,
      lastEventAt: 55_000,
      error: "Native hook relay unavailable",
      progressSummary: "Native hook relay unavailable",
      terminalSummary: "Native hook relay unavailable",
    });
  });

  it.each(["running", "completed", "errored", "blocked"])(
    "leaves a successor unchanged by a predecessor wait snapshot (%s)",
    (status) => {
      const predecessor = taskRecord({ childThreadId: "child-thread", status: "succeeded" });
      const records = new Map<string, AgentHarnessTaskRecord>([[predecessor.runId!, predecessor]]);
      const runtime = createRecordedRuntime(records);
      const mirror = new CodexNativeSubagentTaskMirror(
        { parentThreadId: "parent-thread", now: () => 60_000 },
        runtime,
      );
      mirror.restoreCurrentTaskRun("child-thread", predecessor);
      mirror.markAuthoritativeCompletion("child-thread");
      mirror.startFollowupTurn("child-thread", "turn-b", "parent-thread");
      const successorRunId = codexNativeSubagentRunId("child-thread", "turn-b");
      const beforeWait = structuredClone([...records.entries()]);

      mirror.handleNotification({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          item: {
            type: "collabAgentToolCall",
            tool: "wait",
            receiverThreadIds: ["child-thread"],
            agentsStates: { "child-thread": { status, message: "predecessor result" } },
          },
        },
      });

      expect([...records.entries()]).toEqual(beforeWait);
      expect(runtime.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
      expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
      mirror.handleNotification({
        method: "thread/status/changed",
        params: { threadId: "child-thread", status: { type: "active", activeFlags: [] } },
      });
      expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledOnce();
      expect(records.get(successorRunId)?.progressSummary).toBe("Subagent is active.");
    },
  );

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
          tool: "spawn_agent",
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
      expectedTask: expectedAssignment(runtime),
      lastEventAt: 60_000,
      progressSummary: "Subagent is initializing.",
    });
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: expectedAssignment(runtime),
      lastEventAt: 60_000,
      progressSummary: "done",
    });
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });
});
