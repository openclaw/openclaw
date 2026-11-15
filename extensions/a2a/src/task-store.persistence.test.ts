import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { A2aTaskStore } from "./task-store.js";

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
    const store = new A2aTaskStore(durable);
    const task = store.create("ctx", "alice", "m".repeat(800_000));
    store.start(task.id);
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
              text: "A2A terminal result could not be stored; it will not survive a Gateway restart (PLUGIN_STATE_LIMIT_EXCEEDED)",
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
