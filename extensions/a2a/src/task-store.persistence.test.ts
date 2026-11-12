import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { A2aTaskStore } from "./task-store.js";
import { createPendingStoreFixture } from "./task-store.test-support.js";

it("settles a definite production storage-limit rejection without retaining a false success", async () => {
  const state = await createOpenClawTestState({ label: "a2a-terminal-storage-limit" });
  try {
    type Terminal = Parameters<ConstructorParameters<typeof A2aTaskStore>[0]["register"]>[1];
    const durable = createPluginStateKeyedStoreV2ForTests<Terminal>(
      "a2a",
      {
        namespace: "a2a-terminal-default",
        maxEntries: 500,
        env: state.env,
      },
      { assertCurrent() {} },
    );
    const register = vi.spyOn(durable, "register");
    const store = new A2aTaskStore(durable, createPendingStoreFixture());
    const task = store.create("ctx", "alice", "m".repeat(800_000));
    await store.start(task.id);
    const waiting = store.wait(task, 0);
    const settled = vi.fn();
    void waiting.then(settled);
    await expect(store.complete(task.id, "r".repeat(300_000))).resolves.toMatchObject({
      status: { state: "TASK_STATE_FAILED" },
      artifacts: [{ parts: [{ text: "r".repeat(300_000) }] }],
    });
    await expect(waiting).resolves.toMatchObject({
      status: {
        state: "TASK_STATE_FAILED",
        message: {
          parts: [
            {
              text: "A2A terminal result could not be stored; after a Gateway restart the outcome may be unknown (PLUGIN_STATE_LIMIT_EXCEEDED)",
            },
          ],
        },
      },
    });
    expect(settled).toHaveBeenCalledOnce();
    expect(store.get(task.id, "alice")?.status.state).toBe("TASK_STATE_FAILED");
    expect(store.get(task.id, "bob")).toBeUndefined();
    await expect(store.fail(task.id, "dispatch fallback")).resolves.toBe(task);
    await expect(store.stop()).resolves.toBeUndefined();
    expect(register).toHaveBeenCalledOnce();
    expect(await durable.entries()).toEqual([]);
  } finally {
    await state.cleanup();
  }
});

it("keeps pending admissions through capacity pressure and recovers their original task identities", async () => {
  const state = await createOpenClawTestState({ label: "a2a-pending-recovery" });
  try {
    type Terminal = Parameters<ConstructorParameters<typeof A2aTaskStore>[0]["register"]>[1];
    type Pending = Parameters<ConstructorParameters<typeof A2aTaskStore>[1]["register"]>[1];
    const terminal = createPluginStateKeyedStoreV2ForTests<Terminal>(
      "a2a",
      { namespace: "a2a-terminal-default", maxEntries: 500, env: state.env },
      { assertCurrent() {} },
    );
    const pending = createPluginStateKeyedStoreV2ForTests<Pending>(
      "a2a",
      {
        namespace: "a2a-pending-default",
        maxEntries: 1,
        overflowPolicy: "reject-new",
        env: state.env,
      },
      { assertCurrent() {} },
    );
    const store = new A2aTaskStore(terminal, pending);
    const first = store.create("ctx", "alice", "first");
    await store.start(first.id);
    const refused = store.create("ctx", "alice", "next");
    await expect(store.start(refused.id)).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    expect(store.get(refused.id, "alice")).toBeUndefined();
    expect((await pending.entries()).map(({ key }) => key)).toEqual([first.id]);
    await store.complete(first.id, "known answer");
    const retry = store.create("ctx", "alice", "next");
    await store.start(retry.id);

    const reopened = new A2aTaskStore(terminal, pending);
    await reopened.restore();
    expect(reopened.get(first.id, "alice")).toEqual(first);
    expect(reopened.get(retry.id, "alice")?.status.state).toBe("TASK_STATE_FAILED");
    expect(reopened.create("other-context", "alice", "next").id).toBe(retry.id);
    expect(await reopened.start(retry.id)).toBeUndefined();
    expect(await pending.entries()).toEqual([]);
  } finally {
    await state.cleanup();
  }
});
