import { describe, expect, it, vi } from "vitest";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  type CodexThreadReadResponse,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createTaskScope,
  registerParent,
  threadRead,
  taskRecord,
} from "./native-subagent-monitor.test-harness.js";
describe("cold native task identity across history reads", () => {
  it.each(["matching", "before-read", "replaced", "duplicate", "removed"])(
    "keeps the selected task identity for %s",
    async (kind) => {
      vi.useFakeTimers();
      const client = createClient();
      try {
        const requesterSessionKey = `agent:main:discord:channel:cold-task-${kind}`;
        const task = taskRecord({
          childThreadId: "child-thread",
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
        const parent = registerParent(monitor, "parent-thread", requesterSessionKey);
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
        parent.unregister();
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

describe("review3 cold connection ownership", () => {
  it.each([
    "matching",
    "foreign",
    "unavailable",
    "foreign-physical",
    "foreign-revision",
    "missing-saved",
    "missing-both",
  ])("checks the %s current connection when reconstructing an old parent", async (kind) => {
    vi.useFakeTimers();
    const client = createClient();
    try {
      client.setThreadRead(
        "child-thread",
        threadRead({ parentThreadId: "old-parent", result: "old result" }),
      );
      const runtime = createRuntime();
      const task = taskRecord({
        childThreadId: "child-thread",
        status: "succeeded",
        deliveryStatus: "pending",
        endedAt: Date.now(),
      });
      const saved = createCodexNativeSubagentHistoryOwner({
        parentThreadId: "old-parent",
        sessionId: "physical-1",
        lifecycleRevision: "revision-1",
        binding: {
          threadId: "old-parent",
          cwd: "/workspace",
          appServerRuntimeFingerprint: "connection-A",
        },
      });
      const current =
        kind === "unavailable" || kind === "missing-both"
          ? undefined
          : createCodexNativeSubagentHistoryOwner({
              parentThreadId: "current-parent",
              sessionId: kind === "foreign-physical" ? "physical-2" : "physical-1",
              lifecycleRevision: kind === "foreign-revision" ? "revision-2" : "revision-1",
              binding: {
                threadId: "current-parent",
                cwd: "/workspace",
                appServerRuntimeFingerprint: kind === "foreign" ? "connection-B" : "connection-A",
              },
            });
      if (!saved) {
        throw new Error("expected a production history owner");
      }
      task.detail =
        kind === "missing-saved" || kind === "missing-both" ? undefined : { nativeHistory: saved };
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
        parentThreadId: "current-parent",
        requesterSessionKey: task.requesterSessionKey,
        taskRuntimeScope: createTaskScope(task.requesterSessionKey),
        agentId: "main",
        historyOwner: current,
      });
      await vi.advanceTimersByTimeAsync(0);
      parent.unregister();
      await vi.advanceTimersByTimeAsync(100);
      expect(client.request).toHaveBeenCalledWith(
        "thread/read",
        expect.objectContaining({ threadId: "child-thread" }),
        expect.any(Object),
      );
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(
        kind === "matching" ? 1 : 0,
      );
      expect(task.deliveryStatus).toBe(kind === "matching" ? "delivered" : "pending");
      if (kind === "missing-saved" || kind === "missing-both") {
        expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
        expect(runtime.setDetachedTaskDeliveryStatusByRunId).not.toHaveBeenCalled();
      }
    } finally {
      client.close();
      vi.useRealTimers();
    }
  });
});
