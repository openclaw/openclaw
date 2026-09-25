import type { AgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { registerCodexEventProjectorTestLifecycle } from "./event-projector.test-harness.js";
import { CodexNativeSubagentCompletionDelivery } from "./native-subagent-completion-delivery.js";
import {
  CodexNativeSubagentMonitor,
  childTurnCompletedNotification,
  createClient,
  createRuntime,
  notifyChildStarted,
  registerParent,
  registerDetachedChild,
  nativeCompletionNotification,
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
    const owner = await registerParent(monitor);
    owner.bindTurn("parent-turn");
    await notifyChildStarted(client);
    const list = runtime.listTaskRecords.getMockImplementation()!;
    let unavailable = true;
    const pending: Promise<void>[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- Invoked below with .call(this, ...) to preserve the observed instance.
    const deliver = CodexNativeSubagentCompletionDelivery.prototype.deliverPending;
    const observed = vi
      .spyOn(CodexNativeSubagentCompletionDelivery.prototype, "deliverPending")
      .mockImplementation(function (this: CodexNativeSubagentCompletionDelivery, state, child) {
        runtime.listTaskRecords.mockImplementation(() => {
          if (unavailable) {
            throw new Error("task lookup unavailable");
          }
          return list();
        });
        const promise = deliver.call(this, state, child);
        pending.push(promise);
        void promise.catch(() => {});
        return promise;
      });
    try {
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
      await owner.unregister();
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
        .mockImplementation(function (this: CodexNativeSubagentCompletionDelivery, state, child) {
          captured = { delivery: this, state, child };
          const attempt = original.call(this, state, child);
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
});
