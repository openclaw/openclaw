import { describe, expect, it, vi } from "vitest";
import {
  type CodexThreadReadResponse,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createTaskScope,
  notifyChildStarted,
  registerDetachedChild,
  nativeCompletionNotification,
  nativeHistoryOwner,
  registerParent,
  threadRead,
  taskRecord,
} from "./native-subagent-monitor.test-support.js";
describe("cold native task identity across history reads", () => {
  it.each(["matching", "before-read", "replaced", "duplicate", "removed"])(
    "keeps the selected task identity for %s",
    async (kind) => {
      vi.useFakeTimers();
      const client = createClient();
      try {
        const requesterSessionKey = `agent:main:discord:channel:cold-task-${kind}`;
        const historyOwner = nativeHistoryOwner();
        const task = taskRecord({
          childThreadId: "child-thread",
          historyOwner,
          requesterSessionKey,
          status: "succeeded",
          deliveryStatus: "pending",
          endedAt: Date.now(),
        });
        const replacement = { ...task, taskId: "replacement-task" };
        let rows = [task];
        let listCalls = 0;
        const runtime = createRuntime();
        runtime.listTaskRecords.mockImplementation(() => {
          listCalls += 1;
          if (kind === "before-read" && listCalls === 2) {
            rows = [replacement];
          }
          return rows;
        });
        runtime.finalizeTaskRunByRunId.mockImplementation(() => rows);
        runtime.setDetachedTaskDeliveryStatusByRunId.mockImplementation((params) => {
          for (const row of rows) {
            row.deliveryStatus = params.deliveryStatus;
          }
          return rows;
        });
        let releaseRead: (value: CodexThreadReadResponse) => void = () => {
          throw new Error("history read not initialized");
        };
        const heldRead = new Promise<CodexThreadReadResponse>((resolve) => {
          releaseRead = resolve;
        });
        client.setThreadReadFactory("child-thread", async () => await heldRead);
        const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
          recoveryPollDelaysMs: [],
          completionDeliveryRetryDelaysMs: [10],
        });
        const parent = registerParent(monitor, "parent-thread", requesterSessionKey, historyOwner);
        await vi.advanceTimersByTimeAsync(0);
        if (kind === "replaced") {
          rows = [replacement];
        } else if (kind === "duplicate") {
          rows = [task, replacement];
        } else if (kind === "removed") {
          rows = [];
        } else if (kind === "matching") {
          rows = [{ ...task }];
        }
        await parent.unregister();
        releaseRead(threadRead({ result: "original child result" }));
        await vi.advanceTimersByTimeAsync(100);
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(
          kind === "matching" ? 1 : 0,
        );
        if (kind === "matching") {
          expect(rows[0]?.deliveryStatus).toBe("delivered");
        } else {
          expect(runtime.tryCreateRunningTaskRun).not.toHaveBeenCalled();
          expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
          expect(runtime.setDetachedTaskDeliveryStatusByRunId).not.toHaveBeenCalled();
          expect(task.deliveryStatus).toBe("pending");
          expect(replacement.deliveryStatus).toBe("pending");
        }
      } finally {
        client.close();
        vi.useRealTimers();
      }
    },
  );
});

describe("native completion custody and recovery", () => {
  it("releases a blocked completion projection without polling or settling the retained task", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const successorClient = createClient();
    try {
      const runtime = createRuntime();
      runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
        delivered: false,
        path: "none",
        recoveryBlocked: true,
      });
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
        completionDeliveryMaxRetries: 1,
      });
      await registerDetachedChild(client, monitor);
      await client.notify(nativeCompletionNotification());
      await vi.advanceTimersByTimeAsync(100);
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1);
      expect(
        runtime.setDetachedTaskDeliveryStatusByRunId.mock.calls.some(
          ([call]) => call.deliveryStatus === "failed" || call.deliveryStatus === "delivered",
        ),
      ).toBe(false);
      const successorRuntime = createRuntime();
      const successor = new CodexNativeSubagentMonitor(successorClient as never, successorRuntime);
      await registerDetachedChild(successorClient, successor);
      await successorClient.notify(nativeCompletionNotification());
      expect(successorRuntime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1);
    } finally {
      client.close();
      successorClient.close();
      vi.useRealTimers();
    }
  });

  it("does not exhaust delivery retries while the host recovery owns completion", async () => {
    vi.useFakeTimers();
    const client = createClient();
    try {
      const runtime = createRuntime();
      runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
        delivered: false,
        path: "none",
        recoveryPending: true,
      });
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
        completionDeliveryMaxRetries: 1,
      });
      await registerDetachedChild(client, monitor);
      await client.notify(nativeCompletionNotification());
      await vi.advanceTimersByTimeAsync(50);
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(6);
      expect(
        runtime.setDetachedTaskDeliveryStatusByRunId.mock.calls.some(
          ([call]) => call.deliveryStatus === "failed",
        ),
      ).toBe(false);
      runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
        delivered: true,
        path: "direct",
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenLastCalledWith(
        expect.objectContaining({ deliveryStatus: "delivered" }),
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(7);
    } finally {
      client.close();
      vi.useRealTimers();
    }
  });

  it.each(["success", "failure", "throw"])(
    "preserves concurrent durable native settlement after %s",
    async (outcome) => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const requesterSessionKey = `agent:main:discord:channel:review8-settled-${outcome}`;
      const historyOwner = nativeHistoryOwner();
      const owner = registerParent(monitor, "parent-thread", requesterSessionKey, historyOwner);
      await notifyChildStarted(client);
      await owner.unregister();
      const task = {
        ...taskRecord({ childThreadId: "child-thread", historyOwner }),
        requesterSessionKey,
        ownerKey: requesterSessionKey,
      };
      runtime.listTaskRecords.mockImplementation(() => [task]);
      runtime.setDetachedTaskDeliveryStatusByRunId.mockImplementation((params) => {
        task.deliveryStatus = params.deliveryStatus;
        return [task];
      });
      runtime.deliverAgentHarnessTaskCompletion.mockImplementationOnce(async () => {
        await Promise.resolve();
        task.deliveryStatus = "delivered";
        if (outcome === "throw") {
          throw new Error("response lost after durable settlement");
        }
        return outcome === "success"
          ? { delivered: true, path: "direct" }
          : { delivered: false, path: "none", error: "response unavailable" };
      });
      try {
        await client.notify(nativeCompletionNotification());
        expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledOnce();
        expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledOnce();
        expect(task.deliveryStatus).toBe("delivered");
      } finally {
        client.close();
      }
    },
  );

  it.each(["matching", "connection", "physical", "revision", "parent", "invalid", "late-physical"])(
    "checks saved native history before task mutation for %s",
    async (kind) => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
      });
      const requesterSessionKey = `agent:main:discord:channel:review8-history-${kind}`;
      const historyOwner = {
        parentThreadId: "parent-thread",
        sessionId: "physical-1",
        lifecycleRevision: "revision-1",
        connectionFingerprint: "a".repeat(64),
      };
      const owner = monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey,
        taskRuntimeScope: createTaskScope(requesterSessionKey),
        agentId: "main",
        historyOwner,
      });
      await notifyChildStarted(client);
      await owner.unregister();
      const task = {
        ...taskRecord({ childThreadId: "child-thread" }),
        requesterSessionKey,
        ownerKey: requesterSessionKey,
      };
      const saved = { ...historyOwner };
      if (kind === "connection") {
        saved.connectionFingerprint = "b".repeat(64);
      } else if (kind === "physical") {
        saved.sessionId = "different-physical";
      } else if (kind === "revision") {
        saved.lifecycleRevision = "different-revision";
      } else if (kind === "parent") {
        saved.parentThreadId = "different-parent";
      }
      task.detail = { nativeHistory: kind === "invalid" ? { sessionId: "partial" } : saved };
      runtime.listTaskRecords.mockImplementation(() => [task]);
      if (kind === "late-physical") {
        runtime.deliverAgentHarnessTaskCompletion.mockImplementationOnce(async () => {
          await Promise.resolve();
          task.detail = { nativeHistory: { ...historyOwner, sessionId: "replacement-physical" } };
          return { delivered: true, path: "direct" };
        });
      }
      try {
        await client.notify(nativeCompletionNotification());
        const admitted = kind === "matching" || kind === "late-physical";
        expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(admitted ? 1 : 0);
        expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledTimes(
          kind === "matching" ? 2 : kind === "late-physical" ? 1 : 0,
        );
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(admitted ? 1 : 0);
      } finally {
        client.close();
      }
    },
  );

  it.each(["single", "before-finalize", "after-success", "after-failure", "after-throw"])(
    "does not mutate ambiguous native task custody %s",
    async (phase) => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
      });
      const requesterSessionKey = `agent:main:discord:channel:review7-${phase}`;
      const historyOwner = nativeHistoryOwner();
      const owner = registerParent(monitor, "parent-thread", requesterSessionKey, historyOwner);
      await notifyChildStarted(client);
      await owner.unregister();
      const task = {
        ...taskRecord({ childThreadId: "child-thread", historyOwner }),
        requesterSessionKey,
        ownerKey: requesterSessionKey,
      };
      const peer = { ...task, taskId: "distinct-peer-task", task: "different requested work" };
      const rows = phase === "before-finalize" ? [task, peer] : [task];
      runtime.listTaskRecords.mockImplementation(() => rows);
      runtime.deliverAgentHarnessTaskCompletion.mockImplementationOnce(async () => {
        await Promise.resolve();
        if (phase !== "single") {
          rows.push(peer);
        }
        if (phase === "after-throw") {
          throw new Error("controlled announcement failure");
        }
        return phase === "after-failure"
          ? { delivered: false, path: "none", error: "not delivered" }
          : { delivered: true, path: "direct" };
      });
      try {
        await client.notify(nativeCompletionNotification());
        expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(
          phase === "before-finalize" ? 0 : 1,
        );
        expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledTimes(
          phase === "single" ? 2 : phase === "before-finalize" ? 0 : 1,
        );
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(
          phase === "before-finalize" ? 0 : 1,
        );
      } finally {
        client.close();
      }
    },
  );

  it("keeps a currently observed child on the live path without historical ownership metadata", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    const requesterSessionKey = "agent:main:discord:channel:live-unrecorded";
    const parent = monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey,
      taskRuntimeScope: createTaskScope(requesterSessionKey),
      agentId: "main",
    });
    await notifyChildStarted(client);
    await parent.unregister();
    const task = {
      ...taskRecord({ childThreadId: "child-thread", requesterSessionKey }),
      detail: undefined,
    };
    runtime.listTaskRecords.mockReturnValue([task]);
    runtime.finalizeTaskRunByRunId.mockReturnValue([task]);
    runtime.setDetachedTaskDeliveryStatusByRunId.mockImplementation((params) => {
      task.deliveryStatus = params.deliveryStatus;
      return [task];
    });
    try {
      await client.notify(nativeCompletionNotification());
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
      expect(task.deliveryStatus).toBe("delivered");
    } finally {
      client.close();
    }
  });

  it.each(["matching", "foreign-parent", "invalid"])(
    "honors the persisted %s native history locator before host delivery",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const client = createClient();
        client.setThreadRead("child-thread", threadRead({ status: "completed", result: "result" }));
        const runtime = createRuntime();
        const task = taskRecord({
          childThreadId: "child-thread",
          status: "succeeded",
          deliveryStatus: "pending",
          endedAt: Date.now(),
        });
        task.detail = {
          nativeHistory:
            kind === "invalid"
              ? { sessionId: "physical-1" }
              : {
                  parentThreadId: kind === "matching" ? "parent-thread" : "foreign-parent",
                  sessionId: "physical-1",
                  lifecycleRevision: "revision-1",
                  connectionFingerprint: "a".repeat(64),
                },
        };
        runtime.listTaskRecords.mockReturnValue([task]);
        runtime.finalizeTaskRunByRunId.mockReturnValue([task]);
        runtime.setDetachedTaskDeliveryStatusByRunId.mockImplementation((params) => {
          task.deliveryStatus = params.deliveryStatus;
          return [task];
        });
        const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
          recoveryPollDelaysMs: [],
          completionDeliveryRetryDelaysMs: [10],
        });
        const parent = monitor.registerParent({
          parentThreadId: "parent-thread",
          requesterSessionKey: task.requesterSessionKey,
          taskRuntimeScope: createTaskScope(task.requesterSessionKey),
          agentId: "main",
          historyOwner: {
            parentThreadId: "parent-thread",
            sessionId: "physical-1",
            lifecycleRevision: "revision-1",
            connectionFingerprint: "a".repeat(64),
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        await parent.unregister();
        await vi.advanceTimersByTimeAsync(100);
        if (kind === "matching") {
          expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              expectedRequester: { sessionId: "physical-1", lifecycleRevision: "revision-1" },
            }),
          );
        } else {
          expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
          expect(task.deliveryStatus).toBe("pending");
          client.close();
          task.detail = {
            nativeHistory: {
              parentThreadId: "parent-thread",
              sessionId: "physical-1",
              lifecycleRevision: "revision-1",
              connectionFingerprint: "a".repeat(64),
            },
          };
          const replacement = createClient();
          replacement.setThreadRead(
            "child-thread",
            threadRead({ status: "completed", result: "result" }),
          );
          const replacementMonitor = new CodexNativeSubagentMonitor(replacement as never, runtime, {
            recoveryPollDelaysMs: [],
          });
          const replacementParent = replacementMonitor.registerParent({
            parentThreadId: "parent-thread",
            requesterSessionKey: task.requesterSessionKey,
            taskRuntimeScope: createTaskScope(task.requesterSessionKey),
            agentId: "main",
            historyOwner: {
              parentThreadId: "parent-thread",
              sessionId: "physical-1",
              lifecycleRevision: "revision-1",
              connectionFingerprint: "a".repeat(64),
            },
          });
          await vi.advanceTimersByTimeAsync(0);
          await replacementParent.unregister();
          await vi.advanceTimersByTimeAsync(0);
          expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1);
          expect(task.deliveryStatus).toBe("delivered");
          replacement.close();
        }
        client.close();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
