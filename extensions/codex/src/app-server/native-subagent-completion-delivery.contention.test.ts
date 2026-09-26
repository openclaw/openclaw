import type { AgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { registerCodexEventProjectorTestLifecycle } from "./event-projector.test-harness.js";
import { CodexNativeSubagentCompletionDelivery } from "./native-subagent-completion-delivery.js";
import {
  CodexNativeSubagentMonitor,
  childTurnCompletedNotification,
  createClient,
  createRecordedRuntime,
  createRuntime,
  notifyChildStarted,
  registerParent,
  registerDetachedChild,
  nativeCompletionNotification,
  nativeHistoryOwner,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";

describe("native completion database contention", () => {
  registerCodexEventProjectorTestLifecycle();

  it("retains a completion while task lookup is unavailable", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      completionDeliveryRetryDelaysMs: [1],
    });
    let owner: Awaited<ReturnType<typeof registerParent>> | undefined;
    const list = runtime.listTaskRecords.getMockImplementation()!;
    let unavailable = true;
    const pending: Promise<void>[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- Invoked below with .call(this, ...) to preserve the observed instance.
    const deliver = CodexNativeSubagentCompletionDelivery.prototype.deliverPending;
    const observed = vi
      .spyOn(CodexNativeSubagentCompletionDelivery.prototype, "deliverPending")
      .mockImplementation(function (
        this: CodexNativeSubagentCompletionDelivery,
        state,
        child,
        trigger,
      ) {
        runtime.listTaskRecords.mockImplementation(() => {
          if (unavailable) {
            throw new Error("task lookup unavailable");
          }
          return list();
        });
        const promise = deliver.call(this, state, child, trigger);
        pending.push(promise);
        void promise.catch(() => {});
        return promise;
      });
    try {
      owner = await registerParent(monitor);
      owner.bindTurn("parent-turn");
      await notifyChildStarted(client);
      await client.notify(
        childTurnCompletedNotification({
          status: "completed",
          items: [
            { type: "agentMessage", id: "final", phase: "final_answer", text: "Result preserved." },
          ],
        }),
      );
      expect(pending.length).toBeGreaterThan(0);
      expect(await Promise.allSettled(pending)).toEqual(
        pending.map(() => ({ status: "fulfilled", value: undefined })),
      );
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      unavailable = false;
      await owner.unregister();
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.listTaskRecords()).toEqual([
        expect.objectContaining({ status: "succeeded", deliveryStatus: "delivered" }),
      ]);
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ result: "Result preserved." }),
      );
    } finally {
      runtime.listTaskRecords.mockImplementation(list);
      monitor.dispose();
      await owner?.unregister();
      await Promise.allSettled(pending);
      observed.mockRestore();
      client.close();
      vi.useRealTimers();
    }
  });

  it("keeps a durable delivery receipt when its next task read fails", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
      completionDeliveryRetryDelaysMs: [10],
    });
    try {
      await registerDetachedChild(client, monitor);
      const list = runtime.listTaskRecords.getMockImplementation()!;
      let unavailable = false;
      runtime.listTaskRecords.mockImplementation(() => {
        if (unavailable) {
          throw new Error("task read unavailable after delivery");
        }
        return list();
      });
      runtime.deliverAgentHarnessTaskCompletion.mockImplementation(async () => {
        unavailable = true;
        return { delivered: true, path: "direct" };
      });
      await client.notify(nativeCompletionNotification({ result: "Keep this receipt." }));
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
      expect(list()[0]).toMatchObject({ status: "succeeded", deliveryStatus: "pending" });
      unavailable = false;
      await vi.advanceTimersByTimeAsync(10);
      expect(list()[0]).toMatchObject({
        deliveryStatus: "delivered",
        terminalSummary: "Keep this receipt.",
      });
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
    } finally {
      monitor.dispose();
      client.close();
      vi.useRealTimers();
    }
  });

  it.each(["throw", "empty"] as const)(
    "settles exhausted delivery after a %s status write without sending again",
    async (failure) => {
      vi.useFakeTimers();
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
        completionDeliveryRetryDelaysMs: [10],
        completionDeliveryMaxRetries: 1,
      });
      try {
        await registerDetachedChild(client, monitor);
        const update = runtime.setDetachedTaskDeliveryStatusByRunId.getMockImplementation()!;
        let unavailable = true;
        runtime.setDetachedTaskDeliveryStatusByRunId.mockImplementation((params) => {
          if (unavailable && params.deliveryStatus === "failed") {
            if (failure === "throw") {
              throw new Error("failed status unavailable");
            }
            return [];
          }
          return update(params);
        });
        runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
          delivered: false,
          path: "none",
          error: "delivery unavailable",
        });
        await client.notify(nativeCompletionNotification({ result: "Undelivered result." }));
        await vi.advanceTimersByTimeAsync(30);
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(2);
        expect(runtime.listTaskRecords()[0]).toMatchObject({
          deliveryStatus: "pending",
          terminalSummary: "Undelivered result.",
        });
        unavailable = false;
        await vi.advanceTimersByTimeAsync(10);
        expect(runtime.listTaskRecords()[0]).toMatchObject({
          deliveryStatus: "failed",
          error: "delivery unavailable",
        });
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        monitor.dispose();
        client.close();
        vi.useRealTimers();
      }
    },
  );

  it.each(["receipt", "retirement"] as const)(
    "rechecks %s after the exhausted-status writer yields",
    async (change) => {
      vi.useFakeTimers();
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
        completionDeliveryMaxRetries: 0,
      });
      const writeStarted = createDeferred<void>();
      const releaseWrite = createDeferred<void>();
      const pending: Promise<void>[] = [];
      type Attempt = Parameters<CodexNativeSubagentCompletionDelivery["deliverPending"]>;
      let captured:
        | { delivery: CodexNativeSubagentCompletionDelivery; state: Attempt[0]; child: Attempt[1] }
        | undefined;
      // oxlint-disable-next-line typescript/unbound-method -- Invoked below with .call(this, ...) to preserve the observed instance.
      const original = CodexNativeSubagentCompletionDelivery.prototype.deliverPending;
      const observed = vi
        .spyOn(CodexNativeSubagentCompletionDelivery.prototype, "deliverPending")
        .mockImplementation(function (
          this: CodexNativeSubagentCompletionDelivery,
          state,
          child,
          trigger,
        ) {
          captured = { delivery: this, state, child };
          const attempt = original.call(this, state, child, trigger);
          pending.push(attempt);
          return attempt;
        });
      const releases = vi.spyOn(CodexNativeSubagentCompletionDelivery.prototype, "release");
      try {
        const tasks: AgentHarnessTaskRuntime =
          runtime.createAgentHarnessTaskRuntime.getMockImplementation()!();
        tasks.setDetachedTaskDeliveryStatusByRunIdAsync = async (params) => {
          if (params.deliveryStatus === "failed") {
            writeStarted.resolve();
            await releaseWrite.promise;
          }
          return runtime.setDetachedTaskDeliveryStatusByRunId(params);
        };
        await registerDetachedChild(client, monitor);
        runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
          delivered: false,
          path: "none",
          error: "delivery unavailable",
        });
        await client.notify(nativeCompletionNotification({ result: "Late receipt result." }));
        await vi.advanceTimersByTimeAsync(10);
        await writeStarted.promise;
        const { delivery, state, child } = captured!;
        if (change === "receipt") {
          delivery.applyReceipts(state, [child.runId], new Map([[child.runId, child]]));
        } else {
          monitor.retireParent("parent-thread");
        }
        const priorReleases = releases.mock.calls.length;
        releaseWrite.resolve();
        await Promise.all(pending);
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
        if (change === "receipt") {
          expect(runtime.listTaskRecords()[0]).toMatchObject({
            deliveryStatus: "delivered",
            terminalSummary: "Late receipt result.",
          });
        } else {
          expect(releases.mock.calls.length).toBe(priorReleases);
        }
      } finally {
        releaseWrite.resolve();
        await Promise.allSettled(pending);
        monitor.dispose();
        client.close();
        releases.mockRestore();
        observed.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("follows an async finalization receipt that lowers the lifecycle floor", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const tasks: AgentHarnessTaskRuntime =
      runtime.createAgentHarnessTaskRuntime.getMockImplementation()!();
    tasks.finalizeTaskRunByRunIdAsync = async (params) => {
      const rows = runtime.finalizeTaskRunByRunId(params);
      for (const row of rows) {
        row.createdAt -= 1;
      }
      return rows;
    };
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    try {
      await registerDetachedChild(client, monitor);
      await client.notify(nativeCompletionNotification({ result: "Earlier terminal event." }));
      expect(runtime.listTaskRecords()[0]).toMatchObject({
        status: "succeeded",
        deliveryStatus: "delivered",
      });
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ result: "Earlier terminal event." }),
      );
    } finally {
      monitor.dispose();
      client.close();
    }
  });

  it.each([
    "ordinary-retry-during-read",
    "receipt-read-failure",
    "foreground-receipt-retry",
  ] as const)(
    "preserves an ordinary retry while rejecting a foreign receipt (%s)",
    async (scenario) => {
      vi.useFakeTimers();
      const client = createClient();
      const runtime = createRecordedRuntime(new Map());
      const tasks: AgentHarnessTaskRuntime =
        runtime.createAgentHarnessTaskRuntime.getMockImplementation()!();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
        completionDeliveryRetryDelaysMs: [10],
      });
      const pending = new Set<Promise<void>>();
      // oxlint-disable-next-line typescript/unbound-method -- Invoked below with .call(this, ...) to preserve the observed instance.
      const original = CodexNativeSubagentCompletionDelivery.prototype.deliverPending;
      const observed = vi
        .spyOn(CodexNativeSubagentCompletionDelivery.prototype, "deliverPending")
        .mockImplementation(function (this: CodexNativeSubagentCompletionDelivery, ...args) {
          const attempt = original.call(this, ...args);
          pending.add(attempt);
          return attempt;
        });
      const settle = async () => {
        while (pending.size > 0) {
          const batch = [...pending];
          pending.clear();
          await Promise.all(batch);
        }
      };
      const readStarted = createDeferred<void>();
      const releaseRead = createDeferred<void>();
      let parent: Awaited<ReturnType<typeof registerParent>> | undefined;
      const observerHistory = nativeHistoryOwner("rotated-parent");
      let observer: Awaited<ReturnType<typeof registerParent>> | undefined;
      let receiptNotification: Promise<void> | undefined;
      const foreground = scenario === "foreground-receipt-retry";
      let unavailable = scenario !== "ordinary-retry-during-read";
      let holdRead = false;
      tasks.prepareTaskRunRead = async (runId) => {
        if (holdRead) {
          readStarted.resolve();
          await releaseRead.promise;
          if (unavailable) {
            throw new Error("receipt lookup unavailable");
          }
        }
        return () => runtime.listTaskRecords().filter((task) => task.runId === runId);
      };
      const collab = (tool: string) =>
        client.notify({
          method: "item/completed",
          params: {
            threadId: "rotated-parent",
            turnId: "observer-turn",
            item: {
              id: `${tool}-receipt`,
              type: "collabAgentToolCall",
              tool,
              status: "completed",
              senderThreadId: "rotated-parent",
              receiverThreadIds: ["child-thread"],
              agentsStates: {
                "child-thread": { status: "completed", message: "Retained result." },
              },
            },
          },
        });
      try {
        parent = await registerParent(monitor, "parent-thread", undefined, nativeHistoryOwner());
        client.setThreadRead(
          "child-thread",
          threadRead({ turnId: "turn-a", result: "Retained result." }),
        );
        runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
          delivered: false,
          path: "direct",
          recoveryPending: true,
        });
        parent.bindTurn("parent-turn");
        await notifyChildStarted(client);
        await client.notify(turnStartedNotification("turn-a"));
        await client.notify(
          childTurnCompletedNotification({
            turnId: "turn-a",
            status: "completed",
            items: [{ type: "agentMessage", id: "final", text: "Retained result." }],
          }),
        );
        await settle();
        if (!foreground) {
          await parent.unregister();
        }
        await settle();
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(foreground ? 0 : 1);
        observer = await registerParent(monitor, "rotated-parent", undefined, observerHistory);
        observer.bindTurn("observer-turn");
        await collab("resumeAgent");
        await settle();
        const stored = structuredClone(runtime.listTaskRecords());
        expect(stored).toEqual([
          expect.objectContaining({
            requesterSessionKey: "agent:main:discord:channel:C123",
            status: "succeeded",
            deliveryStatus: "pending",
            detail: expect.objectContaining({ nativeTurnId: "turn-a" }),
          }),
        ]);
        observerHistory.sessionId = "different-physical-session";
        holdRead = true;
        receiptNotification = collab("wait");
        await readStarted.promise;
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(foreground ? 0 : 1);
        if (scenario === "ordinary-retry-during-read") {
          await vi.advanceTimersByTimeAsync(10);
        }
        releaseRead.resolve();
        await receiptNotification;
        await settle();
        if (scenario !== "ordinary-retry-during-read") {
          expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(
            foreground ? 0 : 1,
          );
          expect(runtime.listTaskRecords()).toEqual(stored);
          unavailable = false;
          if (foreground) {
            await parent.unregister();
          } else {
            await vi.advanceTimersByTimeAsync(10);
          }
          await settle();
        }
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(foreground ? 1 : 2);
        expect(runtime.listTaskRecords()).toEqual(stored);
      } finally {
        unavailable = false;
        releaseRead.resolve();
        await receiptNotification?.catch(() => undefined);
        await settle();
        monitor.retireParent("parent-thread");
        monitor.retireParent("rotated-parent");
        monitor.dispose();
        await observer?.unregister();
        await parent?.unregister();
        await settle();
        observed.mockRestore();
        client.close();
        vi.useRealTimers();
      }
    },
  );
});
