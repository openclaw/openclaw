import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeInForeground, fixture } from "./native-subagent-inventory.test-support.js";
import {
  childTurnCompletedNotification,
  collabItem,
  createClient,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";
import { bindingStoreKey, CODEX_APP_SERVER_BINDING_NAMESPACE } from "./session-binding.js";

function holdCommand(
  type: string,
  key: string,
  matches: (input: Record<string, unknown>) => boolean = () => true,
) {
  const entered = createDeferred<Record<string, unknown>>();
  // oxlint-disable-next-line typescript/unbound-method -- call supplies the intercepted worker receiver.
  const post = Worker.prototype.postMessage;
  let held: (() => void) | undefined;
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    message,
    transferList,
  ) {
    const request = asOptionalRecord(message);
    const command =
      request?.type === "execute" && request.input instanceof Uint8Array
        ? asOptionalRecord(deserialize(request.input))
        : undefined;
    const input = asOptionalRecord(command?.input);
    if (
      !held &&
      command?.type === type &&
      input?.pluginId === "codex" &&
      input.namespace === CODEX_APP_SERVER_BINDING_NAMESPACE &&
      input.key === key &&
      matches(input)
    ) {
      held = () => post.call(this, message, transferList);
      entered.resolve(input);
      return;
    }
    post.call(this, message, transferList);
  });
  return {
    entered: entered.promise,
    release() {
      spy.mockRestore();
      const send = held;
      held = undefined;
      send?.();
    },
  };
}

function trackWrites(f: Awaited<ReturnType<typeof fixture>>) {
  const writes: Promise<boolean>[] = [];
  const mutate = f.store.mutate.bind(f.store);
  vi.spyOn(f.store, "mutate").mockImplementation((...args) => {
    const write = mutate(...args);
    writes.push(write);
    return write;
  });
  return {
    writes,
    async settle() {
      let settled = 0;
      while (settled < writes.length) {
        const batch = writes.slice(settled);
        settled = writes.length;
        await Promise.all(batch);
      }
    },
  };
}

describe("native completion binding publication", () => {
  setupRunAttemptTestHooks();
  beforeEach(() => setRuntimeConfigSnapshot({}));

  it("keeps a detached child current through its source-qualified metadata writes", async () => {
    const f = await fixture({ sqlite: true });
    const writes = trackWrites(f);
    const client = createClient();
    const parent = await f.register(client);
    try {
      await parent.ready;
      parent.bindTurn("parent-turn");
      await f.spawn(client);
      expect(parent.listPendingChildren()).toHaveLength(1);
      await parent.unregister();
      await client.notify(
        childTurnCompletedNotification({
          status: "completed",
          items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: "Result" }],
        }),
      );
      expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ result: "Result" }),
      );
      await writes.settle();
      expect(await f.assignments()).toEqual([]);
    } finally {
      await parent.unregister();
      client.close();
      await Promise.allSettled(writes.writes);
    }
  });

  it.each(["pluginState.observe", "pluginState.compareUpdate"])(
    "keeps completion custody while %s and a later delivery-time write are pending",
    async (phase) => {
      const f = await fixture({ sqlite: true });
      const writes = trackWrites(f);
      const client = createClient();
      const parent = await f.register(client);
      const deliveryEntered = createDeferred<void>();
      const finishDelivery = createDeferred<void>();
      let admit: (() => boolean) | undefined;
      f.deliver.mockImplementation(async (params) => {
        expect(params.completionCustody?.isCurrent()).toBe(true);
        admit = params.isSourceSessionAdmissionAllowed;
        deliveryEntered.resolve();
        await finishDelivery.promise;
        expect(admit?.()).toBe(true);
        return { delivered: true, path: "direct" };
      });
      let gate: ReturnType<typeof holdCommand> | undefined;
      const pending: Promise<unknown>[] = [];
      try {
        await parent.ready;
        parent.bindTurn("parent-turn");
        await f.spawn(client);
        await parent.unregister();
        await writes.settle();
        gate = holdCommand(phase, bindingStoreKey(f.identity));
        const started = f.store.mutate(
          f.identity,
          {
            kind: "patch",
            threadId: f.binding.threadId,
            patch: { rolloutPath: "/workspace/initial-rollout.jsonl" },
          },
          () => {},
          parent.bindingAuthority,
        );
        pending.push(started);
        const command = await Promise.race([
          gate.entered,
          started.then(() => {
            throw new Error("Metadata update settled before the held write");
          }),
        ]);
        expect(command.sessionEntryCurrentSources).toEqual(
          expect.arrayContaining([expect.objectContaining({ sessionKey: f.identity.sessionKey })]),
        );
        const completed = client.notify(
          childTurnCompletedNotification({
            status: "completed",
            items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: "Result" }],
          }),
        );
        pending.push(completed);
        await Promise.race([
          deliveryEntered.promise,
          completed.then(() => {
            throw new Error("Completion lost delivery custody");
          }),
        ]);
        expect(admit?.()).toBe(true);
        gate.release();
        await started;
        gate = holdCommand("pluginState.compareUpdate", bindingStoreKey(f.identity));
        const metadata = f.store.mutate(
          f.identity,
          {
            kind: "patch",
            threadId: f.binding.threadId,
            patch: { rolloutPath: "/workspace/rollout.jsonl" },
          },
          () => {},
          parent.bindingAuthority,
        );
        pending.push(metadata);
        await gate.entered;
        expect(admit?.()).toBe(true);
        gate.release();
        await metadata;
        expect(admit?.()).toBe(true);
        finishDelivery.resolve();
        await completed;
        await writes.settle();
        expect(f.deliver).toHaveBeenCalledOnce();
        expect(await f.assignments()).toEqual([]);
        expect(admit?.()).toBe(false);
      } finally {
        gate?.release();
        finishDelivery.resolve();
        await Promise.allSettled(pending);
        await parent.unregister();
        client.close();
        await Promise.allSettled(writes.writes);
      }
    },
  );

  it("admits a follow-up turn while its successful submission receipt is publishing", async () => {
    const f = await fixture({ sqlite: true });
    const writes = trackWrites(f);
    const client = createClient();
    const parent = await f.register(client);
    let gate: ReturnType<typeof holdCommand> | undefined;
    let receipt: Promise<void> | undefined;
    try {
      await parent.ready;
      parent.bindTurn("parent-turn");
      await f.spawn(client);
      await writes.settle();
      await completeInForeground(client);
      await writes.settle();
      expect(parent.listPendingChildren()).toEqual([]);
      expect(f.deliver).not.toHaveBeenCalled();
      client.setThreadRead(
        "child-thread",
        threadRead({ turnId: "child-turn", result: "Native result" }),
      );
      await client.item(collabItem("sendInput", ["child-thread"], { id: "followup" }));
      gate = holdCommand("pluginState.compareUpdate", bindingStoreKey(f.identity), (input) => {
        if (input.action !== "set" || typeof input.valueJson !== "string") {
          return false;
        }
        const value = asOptionalRecord(JSON.parse(input.valueJson));
        const submissions = asOptionalRecord(value?.nativeSubagentSubmissions);
        return (
          Array.isArray(submissions?.receipts) &&
          submissions.receipts.some((entry: unknown) => {
            const row = asOptionalRecord(entry);
            return row?.callId === "followup" && row.submissionId === "followup-turn";
          })
        );
      });
      receipt = client.sendInputOutput({ callId: "followup", submissionId: "followup-turn" });
      const command = await Promise.race([
        gate.entered,
        receipt.then(() => {
          throw new Error("Receipt settled before the held write");
        }),
      ]);
      expect(command.sessionEntryCurrentSources).toEqual(
        expect.arrayContaining([expect.objectContaining({ sessionKey: f.identity.sessionKey })]),
      );
      const observed = client.startTurn("followup-turn");
      expect(parent.listPendingChildren()).toEqual([
        expect.objectContaining({
          runId: "codex-thread:child-thread:turn:followup-turn",
          state: "running",
        }),
      ]);
      await observed;
      gate.release();
      await receipt;
      await writes.settle();
      expect(await f.submissions()).toEqual([
        expect.objectContaining({
          callId: "followup",
          submissionId: "followup-turn",
          predecessorNativeTurnId: "child-turn",
        }),
      ]);
      await parent.unregister();
      await client.finishTurn("followup-turn", {
        type: "agentMessage",
        id: "followup-final",
        phase: "final_answer",
        text: "Follow-up result",
      });
      await writes.settle();
      expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ result: "Follow-up result" }),
      );
      expect(await f.submissions()).toEqual([]);
      expect(await f.assignments()).toEqual([]);
      await client.finishTurn("followup-turn", {
        type: "agentMessage",
        id: "followup-final",
        phase: "final_answer",
        text: "Follow-up result",
      });
      expect(f.deliver).toHaveBeenCalledOnce();
    } finally {
      gate?.release();
      await receipt;
      await parent.unregister();
      client.close();
      await Promise.allSettled(writes.writes);
    }
  });
});
