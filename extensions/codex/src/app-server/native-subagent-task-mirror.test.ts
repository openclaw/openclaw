// Codex tests cover native subagent task mirror plugin behavior.
import {
  captureAgentHarnessTaskAssignment,
  type AgentHarnessTaskRecord,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { describe, expect, it, vi } from "vitest";
import { createRecordedRuntime, taskRecord } from "./native-subagent-monitor.test-support.js";
import { codexNativeSubagentRunId } from "./native-subagent-task-ids.js";
import { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";
import type { JsonObject } from "./protocol.js";

type TaskLifecycleRuntime = ConstructorParameters<typeof CodexNativeSubagentTaskMirror>[1];

function createRuntime() {
  return {
    assertTaskAssignmentSupported: vi.fn(),
    tryCreateRunningTaskRunAsync: vi.fn<
      NonNullable<TaskLifecycleRuntime["tryCreateRunningTaskRunAsync"]>
    >(async (params) => ({
      ...taskRecord({ childThreadId: "child-thread", requesterSessionKey: "agent:main:main" }),
      ...params,
      progressSummary: params.progressSummary ?? undefined,
      taskId: "task-native-subagent",
    })),
    recordTaskRunProgressByRunIdAsync: vi.fn<
      NonNullable<TaskLifecycleRuntime["recordTaskRunProgressByRunIdAsync"]>
    >(async () => []),
    finalizeTaskRunByRunIdAsync: vi.fn<
      NonNullable<TaskLifecycleRuntime["finalizeTaskRunByRunIdAsync"]>
    >(async () => []),
    prepareTaskRecordsRead: vi.fn(async () => (): AgentHarnessTaskRecord[] => []),
    prepareTaskRunRead: vi.fn<NonNullable<TaskLifecycleRuntime["prepareTaskRunRead"]>>(
      async () => () => [],
    ),
    setDetachedTaskDeliveryStatusByRunIdAsync: vi.fn<
      NonNullable<TaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunIdAsync"]>
    >(async () => []),
  } satisfies TaskLifecycleRuntime;
}

function createMirror(
  overrides: Partial<ConstructorParameters<typeof CodexNativeSubagentTaskMirror>[0]> = {},
) {
  const runtime = createRuntime();
  const mirror = new CodexNativeSubagentTaskMirror(
    { parentThreadId: "parent-thread", requesterSessionKey: "agent:main:main", ...overrides },
    runtime,
  );
  return { runtime, mirror };
}

function notifyCollab(mirror: CodexNativeSubagentTaskMirror, item: JsonObject) {
  return mirror.handleNotification({
    method: "item/completed",
    params: { item: { type: "collabAgentToolCall", senderThreadId: "parent-thread", ...item } },
  });
}

async function expectedAssignment(runtime: ReturnType<typeof createRuntime>) {
  return captureAgentHarnessTaskAssignment(
    (await runtime.tryCreateRunningTaskRunAsync.mock.results[0]!.value)!,
  );
}

describe("CodexNativeSubagentTaskMirror", () => {
  it("creates a silent task-registry task for a native Codex subagent thread", async () => {
    const { runtime, mirror } = createMirror({
      agentId: "main",
      now: () => 20_000,
    });
    await mirror.handleNotification({
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

    expect(runtime.tryCreateRunningTaskRunAsync).toHaveBeenCalledWith({
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
    expect(vi.mocked(runtime.tryCreateRunningTaskRunAsync).mock.calls[0]?.[0]).not.toHaveProperty(
      "childSessionKey",
    );
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 20_000,
      progressSummary: "Subagent is active.",
    });
  });

  it.each([true, false])(
    "preserves creation-time history ownership through progress, completion and recovery (stamped=%s)",
    async (stamped) => {
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
      await notify(initial, "running");
      const originalTask = (await runtime.tryCreateRunningTaskRunAsync.mock.results[0]!.value)!;
      expect(originalTask.detail).toEqual(stamped ? { nativeHistory: historyOwner } : undefined);
      runtime.prepareTaskRecordsRead.mockResolvedValue(() => [originalTask]);
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
      await notify(recovered, "running");
      await notify(recovered, "completed");
      expect(vi.mocked(runtime.tryCreateRunningTaskRunAsync).mock.calls[1]![0]).not.toHaveProperty(
        "detail",
      );
      expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalled();
      expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
      for (const [update] of [
        ...vi.mocked(runtime.recordTaskRunProgressByRunIdAsync).mock.calls,
        ...vi.mocked(runtime.finalizeTaskRunByRunIdAsync).mock.calls,
      ]) {
        expect(update).not.toHaveProperty("detail");
      }
      expect(originalTask.detail).toEqual(stamped ? { nativeHistory: historyOwner } : undefined);
    },
  );

  it("ignores subagent threads spawned by a different parent thread", async () => {
    const { runtime, mirror } = createMirror();
    await mirror.handleNotification({
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

    expect(runtime.tryCreateRunningTaskRunAsync).not.toHaveBeenCalled();
    expect(runtime.recordTaskRunProgressByRunIdAsync).not.toHaveBeenCalled();
    expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
  });

  it("deduplicates repeated thread-started notifications for the same child thread", async () => {
    const { runtime, mirror } = createMirror();
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

    await mirror.handleNotification(notification);
    await mirror.handleNotification(notification);

    expect(runtime.tryCreateRunningTaskRunAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps recoverable system errors non-terminal when authoritative recovery is expected", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 35_000,
    });

    await notifyCollab(mirror, { tool: "spawnAgent", receiverThreadIds: ["child-thread"] });

    await mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });
    await mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "systemError" },
      },
    });
    await mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "active", activeFlags: [] },
      },
    });

    expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenNthCalledWith(1, {
      runId: codexNativeSubagentRunId("child-thread"),
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 35_000,
      progressSummary: "Subagent is idle.",
    });
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenNthCalledWith(2, {
      runId: codexNativeSubagentRunId("child-thread"),
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 35_000,
      progressSummary: "Subagent hit a system error; awaiting recovery.",
    });
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenNthCalledWith(3, {
      runId: codexNativeSubagentRunId("child-thread"),
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 35_000,
      progressSummary: "Subagent is active.",
    });
  });

  it("mirrors spawn state without projecting a later wait snapshot", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 40_000,
    });
    await notifyCollab(mirror, {
      tool: "spawnAgent",
      receiverThreadIds: ["child-thread"],
      prompt: "write the proof file",
      agentsStates: {
        "child-thread": {
          status: "pendingInit",
          message: null,
        },
      },
    });
    await notifyCollab(mirror, {
      tool: "wait",
      receiverThreadIds: [],
      agentsStates: {
        "child-thread": {
          status: "completed",
          message: "done",
        },
      },
    });

    expect(runtime.tryCreateRunningTaskRunAsync).toHaveBeenCalledWith({
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
    expect(vi.mocked(runtime.tryCreateRunningTaskRunAsync).mock.calls[0]?.[0]).not.toHaveProperty(
      "childSessionKey",
    );
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 40_000,
      progressSummary: "Subagent is initializing.",
    });
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledTimes(1);
    expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
  });

  it("mirrors Codex multi-agent V2 activity lifecycle", async () => {
    const { runtime, mirror } = createMirror({
      agentId: "main",
      now: () => 41_000,
    });
    for (const kind of ["started", "interacted", "interrupted"] as const) {
      for (const method of ["item/started", "item/completed"] as const) {
        await mirror.handleNotification({
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
      await mirror.handleNotification({
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

    expect(runtime.tryCreateRunningTaskRunAsync).toHaveBeenCalledTimes(1);
    expect(runtime.tryCreateRunningTaskRunAsync).toHaveBeenCalledWith({
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
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledWith({
      runId: "codex-thread:child-v2",
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 41_000,
      progressSummary: "Subagent received more input.",
    });
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledWith({
      runId: "codex-thread:child-v2",
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 41_000,
      progressSummary: "Subagent was interrupted.",
    });
    expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
  });

  it("uses the notification thread id when collab agent items omit sender thread id", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 42_000,
    });
    await mirror.handleNotification({
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

    expect(runtime.tryCreateRunningTaskRunAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        task: "inspect one thing",
      }),
    );
  });

  it("creates spawn tasks from collab agent states when receiver thread ids are absent", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 43_000,
    });

    await mirror.handleNotification({
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

    expect(runtime.tryCreateRunningTaskRunAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        task: "inspect one thing",
      }),
    );
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        progressSummary: "done",
      }),
    );
    expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
  });

  it("finalizes stale collab agent state from the blocked tool call status", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 45_000,
    });

    await notifyCollab(mirror, {
      tool: "spawnAgent",
      status: "blocked",
      receiverThreadIds: ["child-thread"],
      prompt: "read cwd",
      agentsStates: {
        "child-thread": {
          status: "pendingInit",
          message: "Native hook relay unavailable",
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunIdAsync).not.toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 45_000,
      progressSummary: "Native hook relay unavailable",
    });
    expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: await expectedAssignment(runtime),
      status: "succeeded",
      endedAt: 45_000,
      lastEventAt: 45_000,
      progressSummary: "Native hook relay unavailable",
      terminalSummary: "Native hook relay unavailable",
      terminalOutcome: "blocked",
    });
  });

  it("does not treat completed tool calls as completed subagents", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 46_000,
    });

    await notifyCollab(mirror, {
      tool: "spawnAgent",
      status: "completed",
      receiverThreadIds: ["child-thread"],
      prompt: "read cwd",
      agentsStates: {
        "child-thread": {
          status: "pendingInit",
          message: null,
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 46_000,
      progressSummary: "Subagent is initializing.",
    });
    expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
  });

  it("does not project a failed wait call onto a subagent lifecycle", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 47_000,
    });

    await notifyCollab(mirror, {
      tool: "wait",
      status: "failed",
      receiverThreadIds: [],
      agentsStates: {
        "child-thread": {
          status: "running",
          message: "wait timed out",
        },
      },
    });

    expect(runtime.tryCreateRunningTaskRunAsync).not.toHaveBeenCalled();
    expect(runtime.recordTaskRunProgressByRunIdAsync).not.toHaveBeenCalled();
    expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
  });

  it("records completed collab agent and idle thread states as progress only", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 50_000,
    });

    await notifyCollab(mirror, {
      tool: "spawnAgent",
      receiverThreadIds: ["child-thread"],
      prompt: "write the proof file",
      agentsStates: {
        "child-thread": {
          status: "completed",
          message: "No user task is specified.",
        },
      },
    });
    await mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });

    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledTimes(1);
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 50_000,
      progressSummary: "No user task is specified.",
    });
    expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
  });

  it("keeps terminal collab failures from rewriting authoritative completion", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 52_000,
    });

    await notifyCollab(mirror, {
      tool: "spawnAgent",
      receiverThreadIds: ["child-thread"],
      prompt: "write the proof file",
    });
    mirror.markAuthoritativeCompletion("child-thread");
    await notifyCollab(mirror, {
      tool: "spawnAgent",
      agentsStates: {
        "child-thread": {
          status: "errored",
          message: "later turn failed",
        },
      },
    });

    expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
  });

  it("ignores unadmitted idle status before finalizing an admitted collab failure", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 55_000,
    });

    await mirror.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });
    await notifyCollab(mirror, {
      tool: "spawnAgent",
      status: "failed",
      receiverThreadIds: ["child-thread"],
      prompt: "read cwd",
      agentsStates: {
        "child-thread": {
          status: "pendingInit",
          message: "Native hook relay unavailable",
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunIdAsync).not.toHaveBeenCalled();
    expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenCalledTimes(1);
    expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: await expectedAssignment(runtime),
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
    async (status) => {
      const predecessor = taskRecord({ childThreadId: "child-thread", status: "succeeded" });
      const records = new Map<string, AgentHarnessTaskRecord>([[predecessor.runId!, predecessor]]);
      const runtime = createRecordedRuntime(records);
      const mirror = new CodexNativeSubagentTaskMirror(
        { parentThreadId: "parent-thread", now: () => 60_000 },
        runtime,
      );
      mirror.restoreCurrentTaskRun("child-thread", predecessor);
      mirror.markAuthoritativeCompletion("child-thread");
      await mirror.startFollowupTurn("child-thread", "turn-b", "parent-thread");
      const successorRunId = codexNativeSubagentRunId("child-thread", "turn-b");
      const beforeWait = structuredClone([...records.entries()]);

      await mirror.handleNotification({
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
      expect(runtime.recordTaskRunProgressByRunIdAsync).not.toHaveBeenCalled();
      expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
      await mirror.handleNotification({
        method: "thread/status/changed",
        params: { threadId: "child-thread", status: { type: "active", activeFlags: [] } },
      });
      expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledOnce();
      expect(records.get(successorRunId)?.progressSummary).toBe("Subagent is active.");
    },
  );

  it("drains delayed creation before queued progress in notification order", async () => {
    const { runtime, mirror } = createMirror();
    const created = taskRecord({ childThreadId: "child-thread" });
    const creation = Promise.withResolvers<AgentHarnessTaskRecord | null>();
    const entered = Promise.withResolvers<void>();
    runtime.tryCreateRunningTaskRunAsync.mockImplementationOnce(async () => {
      entered.resolve();
      return await creation.promise;
    });
    const start = notifyCollab(mirror, {
      tool: "spawnAgent",
      receiverThreadIds: ["child-thread"],
      prompt: "Inspect one item",
    });
    let work: Promise<unknown>[] = [start];
    try {
      await Promise.race([
        entered.promise,
        start.then(() => {
          throw new Error("Spawn completed without entering task creation");
        }),
      ]);
      const progress = ["active", "idle"].map((type) =>
        mirror.handleNotification({
          method: "thread/status/changed",
          params: { threadId: "child-thread", status: { type } },
        }),
      );
      const drain = mirror.drain();
      work = [start, ...progress, drain];
      expect(mirror.hasPendingWrites).toBe(true);
      expect(runtime.recordTaskRunProgressByRunIdAsync).not.toHaveBeenCalled();
      creation.resolve(created);
      await drain;
      expect(mirror.hasPendingWrites).toBe(false);
      expect(
        runtime.recordTaskRunProgressByRunIdAsync.mock.calls.map(([update]) => ({
          runId: update.runId,
          expectedTask: update.expectedTask,
          progressSummary: update.progressSummary,
        })),
      ).toEqual([
        {
          runId: created.runId,
          expectedTask: captureAgentHarnessTaskAssignment(created),
          progressSummary: "Subagent is active.",
        },
        {
          runId: created.runId,
          expectedTask: captureAgentHarnessTaskAssignment(created),
          progressSummary: "Subagent is idle.",
        },
      ]);
    } finally {
      creation.resolve(created);
      await Promise.allSettled(work);
    }
  });

  it("does not attach a predecessor turn to a replacement discovered after read preparation", async () => {
    const { runtime, mirror } = createMirror();
    const original = taskRecord({ childThreadId: "child-thread" });
    const expectedTask = captureAgentHarnessTaskAssignment(original);
    mirror.restoreCurrentTaskRun("child-thread", original);
    let current = original;
    const prepared = Promise.withResolvers<() => AgentHarnessTaskRecord[]>();
    const entered = Promise.withResolvers<void>();
    runtime.prepareTaskRecordsRead.mockImplementationOnce(async () => {
      entered.resolve();
      return await prepared.promise;
    });
    const pending = mirror.recordNativeTurn(original.runId!, "predecessor-turn");
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Turn update completed without preparing its task read");
        }),
      ]);
      current = {
        ...original,
        createdAt: original.createdAt + 1,
        detail: { nativeTurnId: "successor-turn" },
      };
      const successor = structuredClone(current);
      prepared.resolve(() => [current]);
      await pending;
      await mirror.drain();
      expect(runtime.recordTaskRunProgressByRunIdAsync).not.toHaveBeenCalled();
      expect(current).toEqual(successor);
      expect(mirror.getTaskAssignment(original.runId!)).toEqual(expectedTask);
    } finally {
      prepared.resolve(() => [current]);
      await Promise.allSettled([pending]);
    }
  });

  it.each(["thread-status", "collab-progress", "collab-failure", "interruption"] as const)(
    "keeps queued %s on its predecessor when recovery selects a successor",
    async (surface) => {
      const predecessor = { ...taskRecord({ childThreadId: "child-thread" }), createdAt: 100 };
      const successor = {
        ...taskRecord({ childThreadId: "child-thread:turn:turn-b" }),
        createdAt: 200,
        task: "Successor work",
      };
      const records = new Map<string, AgentHarnessTaskRecord>([
        [predecessor.runId!, predecessor],
        [successor.runId!, successor],
      ]);
      const runtime = createRecordedRuntime(records);
      const mirror = new CodexNativeSubagentTaskMirror(
        { parentThreadId: "parent-thread" },
        runtime,
      );
      mirror.restoreCurrentTaskRun("child-thread", predecessor);
      const gate = Promise.withResolvers<void>();
      const held = mirror.enqueuePersistence(() => gate.promise);
      const observed =
        surface === "thread-status"
          ? mirror.handleNotification({
              method: "thread/status/changed",
              params: { threadId: "child-thread", status: { type: "active" } },
            })
          : surface === "interruption"
            ? mirror.handleNotification({
                method: "item/completed",
                params: {
                  threadId: "parent-thread",
                  item: {
                    type: "subAgentActivity",
                    kind: "interrupted",
                    agentThreadId: "child-thread",
                  },
                },
              })
            : notifyCollab(mirror, {
                tool: "sendInput",
                agentsStates: {
                  "child-thread": {
                    status: surface === "collab-failure" ? "failed" : "running",
                    message: "Predecessor observation",
                  },
                },
              });
      try {
        // Only an exact commit from this assignment may advance its lifecycle floor.
        const committed = { ...predecessor, createdAt: 99 };
        expect(
          mirror.advanceTaskAssignment(
            captureAgentHarnessTaskAssignment(predecessor),
            captureAgentHarnessTaskAssignment(committed),
          ),
        ).toBe(true);
        records.set(predecessor.runId!, committed);
        mirror.restoreCurrentTaskRun("child-thread", successor);
        gate.resolve();
        await observed;
        await mirror.drain();
        const transition =
          surface === "collab-failure"
            ? runtime.finalizeTaskRunByRunIdAsync
            : runtime.recordTaskRunProgressByRunIdAsync;
        expect(transition).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            runId: predecessor.runId,
            expectedTask: captureAgentHarnessTaskAssignment(committed),
          }),
        );
        expect(records.get(successor.runId!)).toEqual(successor);
        expect(records.get(predecessor.runId!)?.status).toBe(
          surface === "collab-failure" ? "failed" : "running",
        );
      } finally {
        gate.resolve();
        await Promise.allSettled([held, observed]);
      }
    },
  );

  it("routes old and new queued observations around follow-up reservation without undoing later recovery", async () => {
    const predecessor = {
      ...taskRecord({ childThreadId: "child-thread" }),
      label: "Original label",
      task: "Original task",
    };
    const recovered = {
      ...taskRecord({ childThreadId: "child-thread:turn:turn-c" }),
      createdAt: 300,
      task: "Recovered work",
    };
    const records = new Map<string, AgentHarnessTaskRecord>([
      [predecessor.runId!, predecessor],
      [recovered.runId!, recovered],
    ]);
    const runtime = createRecordedRuntime(records);
    const mirror = new CodexNativeSubagentTaskMirror(
      { parentThreadId: "parent-thread", now: () => 200 },
      runtime,
    );
    mirror.restoreCurrentTaskRun("child-thread", predecessor);
    const status = (type: string) =>
      mirror.handleNotification({
        method: "thread/status/changed",
        params: { threadId: "child-thread", status: { type } },
      });
    const gate = Promise.withResolvers<void>();
    const held = mirror.enqueuePersistence(() => gate.promise);
    const oldObservation = status("active");
    const creation = mirror.startFollowupTurn("child-thread", "turn-b", "parent-thread");
    const newObservation = status("idle");
    try {
      mirror.restoreCurrentTaskRun("child-thread", recovered);
      gate.resolve();
      await Promise.all([oldObservation, creation, newObservation]);
      const successorRunId = codexNativeSubagentRunId("child-thread", "turn-b");
      const successor = records.get(successorRunId)!;
      expect(successor).toMatchObject({
        label: predecessor.label,
        task: predecessor.task,
        progressSummary: "Subagent is idle.",
      });
      expect(
        runtime.recordTaskRunProgressByRunIdAsync.mock.calls.map(([params]) => ({
          runId: params.runId,
          expectedTask: params.expectedTask,
        })),
      ).toEqual([
        { runId: predecessor.runId, expectedTask: captureAgentHarnessTaskAssignment(predecessor) },
        { runId: successorRunId, expectedTask: captureAgentHarnessTaskAssignment(successor) },
      ]);
      expect(records.get(recovered.runId!)).toEqual(recovered);
      await status("active");
      expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runId: recovered.runId,
          expectedTask: captureAgentHarnessTaskAssignment(recovered),
        }),
      );
    } finally {
      gate.resolve();
      await Promise.allSettled([held, oldObservation, creation, newObservation]);
    }
  });

  it.each(["rejected", "refused"] as const)(
    "suppresses status after %s initial creation until an explicit creation retry",
    async (failure) => {
      const { runtime, mirror } = createMirror();
      if (failure === "rejected") {
        runtime.tryCreateRunningTaskRunAsync.mockRejectedValueOnce(
          new Error("Creation unavailable"),
        );
      } else {
        runtime.tryCreateRunningTaskRunAsync.mockResolvedValueOnce(null);
      }
      const spawn = () =>
        notifyCollab(mirror, { tool: "spawnAgent", receiverThreadIds: ["child-thread"] });
      const first = spawn();
      if (failure === "rejected") {
        await expect(first).rejects.toThrow("Creation unavailable");
      } else {
        await first;
      }
      const progress = () =>
        mirror.handleNotification({
          method: "thread/status/changed",
          params: { threadId: "child-thread", status: { type: "active" } },
        });
      await progress();
      await notifyCollab(mirror, {
        tool: "sendInput",
        agentsStates: { "child-thread": { status: "failed" } },
      });
      expect(runtime.recordTaskRunProgressByRunIdAsync).not.toHaveBeenCalled();
      expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
      await spawn();
      await progress();
      const created = (await runtime.tryCreateRunningTaskRunAsync.mock.results[1]!.value)!;
      expect(runtime.tryCreateRunningTaskRunAsync).toHaveBeenCalledTimes(2);
      expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          runId: created.runId,
          expectedTask: captureAgentHarnessTaskAssignment(created),
        }),
      );
    },
  );

  it("retries a rejected follow-up creation with the original predecessor metadata and admitted receipt", async () => {
    const predecessor = {
      ...taskRecord({ childThreadId: "child-thread" }),
      label: "Retained label",
      task: "Retained work",
    };
    const records = new Map<string, AgentHarnessTaskRecord>([[predecessor.runId!, predecessor]]);
    const runtime = createRecordedRuntime(records);
    const mirror = new CodexNativeSubagentTaskMirror({ parentThreadId: "parent-thread" }, runtime);
    mirror.restoreCurrentTaskRun("child-thread", predecessor);
    runtime.tryCreateRunningTaskRunAsync.mockRejectedValueOnce(new Error("Follow-up unavailable"));
    await expect(
      mirror.startFollowupTurn("child-thread", "turn-b", "parent-thread"),
    ).rejects.toThrow("Follow-up unavailable");
    const progress = () =>
      mirror.handleNotification({
        method: "thread/status/changed",
        params: { threadId: "child-thread", status: { type: "active" } },
      });
    await progress();
    expect(runtime.recordTaskRunProgressByRunIdAsync).not.toHaveBeenCalled();
    await mirror.startFollowupTurn("child-thread", "turn-b", "parent-thread");
    await progress();
    const successorRunId = codexNativeSubagentRunId("child-thread", "turn-b");
    const successor = records.get(successorRunId)!;
    expect(
      runtime.tryCreateRunningTaskRunAsync.mock.calls.map(([params]) => ({
        runId: params.runId,
        label: params.label,
        task: params.task,
      })),
    ).toEqual([
      { runId: successorRunId, label: predecessor.label, task: predecessor.task },
      { runId: successorRunId, label: predecessor.label, task: predecessor.task },
    ]);
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: successorRunId,
        expectedTask: captureAgentHarnessTaskAssignment(successor),
      }),
    );
    expect(records.get(predecessor.runId!)).toEqual(predecessor);
  });

  it("normalizes collab agent status spelling from alternate event surfaces", async () => {
    const { runtime, mirror } = createMirror({
      now: () => 60_000,
    });

    await notifyCollab(mirror, {
      tool: "spawnAgent",
      receiverThreadIds: ["child-thread"],
      agentsStates: {
        "child-thread": {
          status: "pending_init",
          message: null,
        },
      },
    });
    await notifyCollab(mirror, {
      tool: "spawn_agent",
      agentsStates: {
        "child-thread": {
          status: "success",
          message: "done",
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 60_000,
      progressSummary: "Subagent is initializing.",
    });
    expect(runtime.recordTaskRunProgressByRunIdAsync).toHaveBeenCalledWith({
      runId: "codex-thread:child-thread",
      expectedTask: await expectedAssignment(runtime),
      lastEventAt: 60_000,
      progressSummary: "done",
    });
    expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
  });
});
