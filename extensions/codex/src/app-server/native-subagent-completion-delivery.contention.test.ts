import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { fixture } from "./native-subagent-inventory.test-support.js";
import {
  CodexNativeSubagentMonitor,
  childTurnCompletedNotification,
  createClient,
  createRuntime,
  nativeCompletionNotification,
  notifyChildStarted,
  registerParent,
} from "./native-subagent-monitor.test-support.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

const result = "Keep the accepted native result.";
const completedChild = () =>
  childTurnCompletedNotification({
    status: "completed",
    items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: result }],
  });

describe("native completion settlement", () => {
  it("keeps a durable delivery receipt when its next ownership read fails", async () => {
    const f = await fixture();
    const client = createClient();
    const read = f.store.read.bind(f.store);
    let failNextRead = false;
    let failedReads = 0;
    vi.spyOn(f.store, "read").mockImplementation((identity) => {
      if (failNextRead) {
        failNextRead = false;
        failedReads += 1;
        throw new Error("ownership read unavailable after delivery");
      }
      return read(identity);
    });
    const mutate = f.store.mutate.bind(f.store);
    const writes: Promise<boolean>[] = [];
    const mutations = vi.spyOn(f.store, "mutate").mockImplementation((...args) => {
      const write = mutate(...args);
      writes.push(write);
      return write;
    });
    f.deliver.mockImplementation(async ({ completionCustody }) => {
      assert(completionCustody?.isCurrent());
      failNextRead = true;
      return { delivered: true, path: "direct" };
    });
    const parent = await f.register(client);
    try {
      await parent.ready;
      parent.bindTurn("parent-turn");
      await f.spawn(client);
      await parent.unregister();
      await client.notify(completedChild());
      expect(failedReads).toBe(1);
      expect(f.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ result }));
      expect(
        mutations.mock.calls.filter(
          ([, mutation]) => mutation.kind === "consume-native-subagent-assignment",
        ),
      ).toHaveLength(1);
      await Promise.all(writes);
      expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
      client.close();
      const replacement = await f.register(createClient());
      await replacement.ready;
      await replacement.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
    } finally {
      failNextRead = false;
      await parent.unregister();
      client.close();
      await Promise.allSettled(writes);
    }
  });

  it.each(["receipt", "retired-turn-receipt", "retirement"] as const)(
    "rechecks %s while completion delivery is in flight",
    async (change) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const client = createClient();
      const runtime = createRuntime();
      const entered = createDeferred<void>();
      const delivery = createDeferred<{ delivered: false; path: "none" }>();
      runtime.deliverAgentHarnessCompletion.mockImplementationOnce(async () => {
        entered.resolve();
        return await delivery.promise;
      });
      const releasePin = vi.fn();
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        recoveryPollDelaysMs: [],
        completionDeliveryRetryDelaysMs: [10],
        retainParentThread: () => releasePin,
      });
      const parent = await registerParent(monitor);
      let observer: Awaited<ReturnType<typeof registerParent>> | undefined;
      let completion: Promise<void> | undefined;
      try {
        parent.bindTurn("parent-turn");
        await notifyChildStarted(client);
        await parent.unregister();
        completion = client.notify(completedChild());
        await entered.promise;
        expect(releasePin).not.toHaveBeenCalled();
        const canAdmit =
          runtime.deliverAgentHarnessCompletion.mock.calls[0]?.[0].isSourceSessionAdmissionAllowed;
        expect(canAdmit?.()).toBe(true);
        if (change === "retirement") {
          monitor.retireParent("parent-thread");
          expect(canAdmit?.()).toBe(false);
          expect(releasePin).toHaveBeenCalledOnce();
        } else {
          observer = await registerParent(monitor);
          observer.bindTurn("observer-turn");
          await client.notify(
            nativeCompletionNotification({
              turnId: change === "receipt" ? "observer-turn" : "parent-turn",
              result,
            }),
          );
          // A receipt cannot release custody still owned by the accepted delivery.
          expect(releasePin).not.toHaveBeenCalled();
        }
        delivery.resolve({ delivered: false, path: "none" });
        await completion;
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
        if (change === "retired-turn-receipt") {
          expect(releasePin).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(1);
          await observer?.unregister();
          await vi.advanceTimersByTimeAsync(10);
          expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(2);
        }
        expect(releasePin).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        delivery.resolve({ delivered: false, path: "none" });
        await completion;
        monitor.retireParent("parent-thread");
        await observer?.unregister();
        await parent.unregister();
        monitor.dispose();
        client.close();
        vi.useRealTimers();
      }
    },
  );
});
