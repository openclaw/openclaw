import type { SessionEvent } from "@github/copilot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntime,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { attachEventBridge, type SessionLike } from "./event-bridge.js";
import { createCopilotNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";

export type NativeTaskRuntimeState = {
  current?: Required<
    Pick<
      AgentHarnessTaskRuntime,
      | "assertTaskAssignmentSupported"
      | "createRunningTaskRunAsync"
      | "finalizeTaskRunByRunIdAsync"
      | "prepareTaskRunRead"
    >
  >;
};

export function registerCopilotNativeTaskEventTests({
  createFakeSession,
  makeEvent,
  nativeTaskRuntime,
  flushAsync,
}: {
  createFakeSession: () => SessionLike & { emit: (type: string, event: SessionEvent) => void };
  makeEvent: (type: string, data: Record<string, unknown>) => SessionEvent;
  nativeTaskRuntime: NativeTaskRuntimeState;
  flushAsync: () => Promise<void>;
}) {
  it.each([
    { terminal: "subagent.completed", failureMode: "empty" },
    { terminal: "subagent.failed", failureMode: "throw" },
  ] as const)(
    "retries the original $terminal result after a swallowed $failureMode callback",
    async ({ terminal, failureMode }) => {
      const session = createFakeSession();
      let now = 100;
      let task: AgentHarnessTaskRecord | undefined;
      let attempts = 0;
      nativeTaskRuntime.current = {
        assertTaskAssignmentSupported() {},
        async createRunningTaskRunAsync(params) {
          task = {
            taskId: "owned-task",
            runId: params.runId,
            runtime: "subagent",
            taskKind: "copilot-native",
            requesterSessionKey: "agent:parent:session",
            ownerKey: "agent:parent:session",
            scopeKind: "session",
            task: params.task,
            status: "running",
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
            createdAt: now,
          };
          return task;
        },
        async finalizeTaskRunByRunIdAsync(params) {
          attempts += 1;
          if (attempts === 1) {
            if (failureMode === "throw") {
              throw new Error("store unavailable");
            }
            return [];
          }
          task = {
            ...expectDefined(task, "persisted native task"),
            status: params.status,
            endedAt: params.endedAt,
            lastEventAt: params.lastEventAt,
            error: params.error,
            terminalSummary: params.terminalSummary ?? undefined,
          };
          return [task];
        },
        prepareTaskRunRead: async () => () => (task ? [task] : []),
      };
      const mirror = expectDefined(
        createCopilotNativeSubagentTaskMirror({
          now: () => now,
          scope: {} as AgentHarnessTaskRuntimeScope,
        }),
        "native task mirror",
      );
      const bridge = attachEventBridge(session, {
        getSdkSessionId: () => "sdk-session-id",
        isAborted: () => false,
        onNativeSubagentEvent: (event) => mirror.handleEvent(event),
      });
      const data = {
        agentDescription: "inspect",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-1",
      };
      session.emit("subagent.started", makeEvent("subagent.started", data));
      session.emit(
        terminal,
        makeEvent(terminal, { ...data, error: "child failed", totalTokens: 30 }),
      );
      await bridge.awaitAgentEventChain();
      expect(task?.status).toBe("running");
      expect(attempts).toBe(1);
      bridge.detach();
      now = 200;
      await mirror.finalizeActiveRuns();
      expect(task).toMatchObject({
        status: terminal === "subagent.completed" ? "succeeded" : "failed",
        endedAt: 100,
        lastEventAt: 100,
        error: terminal === "subagent.failed" ? "child failed" : undefined,
        terminalSummary:
          terminal === "subagent.completed"
            ? "Subagent completed (30 tokens)."
            : "Subagent failed.",
      });
      await session.disconnect();
      await mirror.finalizeActiveRuns();
      expect(attempts).toBe(2);
    },
  );

  it("drains accepted native events in order when task creation is deferred", async () => {
    const session = createFakeSession();
    const creationStarted = createDeferred<void>();
    const releaseCreation = createDeferred<void>();
    let task: AgentHarnessTaskRecord | undefined;
    const finalize = vi.fn<NonNullable<AgentHarnessTaskRuntime["finalizeTaskRunByRunIdAsync"]>>(
      async (params) => {
        task = {
          ...expectDefined(task, "created native task"),
          status: params.status,
          endedAt: params.endedAt,
          terminalSummary: params.terminalSummary ?? undefined,
        };
        return [task];
      },
    );
    nativeTaskRuntime.current = {
      assertTaskAssignmentSupported() {},
      async createRunningTaskRunAsync(params) {
        creationStarted.resolve();
        await releaseCreation.promise;
        task = {
          taskId: "deferred-task",
          runId: params.runId,
          runtime: "subagent",
          taskKind: "copilot-native",
          requesterSessionKey: "agent:parent:session",
          ownerKey: "agent:parent:session",
          scopeKind: "session",
          task: params.task,
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: 100,
        };
        return task;
      },
      finalizeTaskRunByRunIdAsync: finalize,
      prepareTaskRunRead: async () => () => (task ? [task] : []),
    };
    const mirror = expectDefined(
      createCopilotNativeSubagentTaskMirror({
        now: () => 100,
        scope: {} as AgentHarnessTaskRuntimeScope,
      }),
      "native task mirror",
    );
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onNativeSubagentEvent: (event) => mirror.handleEvent(event),
    });
    const data = {
      agentDescription: "inspect the repository",
      agentDisplayName: "Researcher",
      agentName: "researcher",
      toolCallId: "call-1",
    };
    session.emit("subagent.started", makeEvent("subagent.started", data));
    session.emit(
      "subagent.completed",
      makeEvent("subagent.completed", { ...data, totalTokens: 30 }),
    );
    bridge.detach();
    session.emit(
      "subagent.failed",
      makeEvent("subagent.failed", { ...data, error: "after detach" }),
    );
    let drained = false;
    const drain = bridge.awaitAgentEventChain().then(() => {
      drained = true;
    });
    try {
      await creationStarted.promise;
      await flushAsync();
      expect(drained).toBe(false);
      expect(finalize).not.toHaveBeenCalled();
    } finally {
      releaseCreation.resolve();
      await drain;
    }
    await mirror.finalizeActiveRuns();
    expect(task).toMatchObject({
      taskId: "deferred-task",
      status: "succeeded",
      terminalSummary: "Subagent completed (30 tokens).",
    });
    expect(finalize).toHaveBeenCalledOnce();
  });
}
