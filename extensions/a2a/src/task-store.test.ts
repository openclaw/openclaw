import { afterEach, describe, expect, it, vi } from "vitest";
import { A2aTaskStore } from "./task-store.js";

describe("A2A task store", () => {
  const stores: A2aTaskStore[] = [];

  function createTaskStore(): A2aTaskStore {
    const store = new A2aTaskStore();
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.stop();
    }
    vi.restoreAllMocks();
  });

  it("correlates concurrent replies by conversation FIFO without cross-talk", () => {
    const store = createTaskStore();
    const aliceFirst = store.create("ctx-alice");
    const bobOnly = store.create("ctx-bob");
    const aliceSecond = store.create("ctx-alice");
    for (const task of [aliceFirst, bobOnly, aliceSecond]) {
      store.start(task.id);
    }

    expect(store.completeNext("ctx-alice", "first")?.id).toBe(aliceFirst.id);
    expect(store.completeNext("ctx-bob", "bob")?.id).toBe(bobOnly.id);
    expect(store.completeNext("ctx-alice", "second")?.id).toBe(aliceSecond.id);
    expect(aliceFirst.artifacts[0]?.parts).toEqual([{ text: "first" }]);
    expect(aliceSecond.artifacts[0]?.parts).toEqual([{ text: "second" }]);
  });

  it("completes empty replies without inventing an artifact", () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice");

    expect(store.completeNext(task.contextId, undefined)).toMatchObject({
      status: {
        state: "TASK_STATE_COMPLETED",
        message: { role: "ROLE_AGENT", parts: [{ text: "Agent completed without reply text" }] },
      },
      artifacts: [],
    });
  });

  it("records bounded failures and policy rejections without consuming sibling replies", () => {
    const store = createTaskStore();
    const failed = store.create("ctx-alice");
    const rejected = store.create("ctx-alice");
    const active = store.create("ctx-alice");

    expect(store.fail(failed.id, new Error(`${"x".repeat(511)}😀tail`))).toMatchObject({
      status: { state: "TASK_STATE_FAILED", message: { parts: [{ text: "x".repeat(511) }] } },
    });
    expect(store.reject(rejected.id, "peer blocked")).toMatchObject({
      status: { state: "TASK_STATE_REJECTED", message: { parts: [{ text: "peer blocked" }] } },
    });
    expect(store.completeNext("ctx-alice", "active reply")?.id).toBe(active.id);
  });

  it("returns working tasks after timeout and accepts the eventual final reply", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice");
    store.start(task.id);

    await expect(store.wait(task.id, 0)).resolves.toMatchObject({
      status: { state: "TASK_STATE_WORKING" },
    });
    expect(store.completeNext("ctx-alice", "late reply")).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "late reply" }] }],
    });
  });

  it("resolves outstanding HTTP waits with their working snapshot on shutdown", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice");
    store.start(task.id);
    const waiting = store.wait(task.id, 120_000);

    store.stop();

    await expect(waiting).resolves.toMatchObject({ status: { state: "TASK_STATE_WORKING" } });
    expect(store.get(task.id)).toBeUndefined();
  });

  it("expires completed tasks after 24 hours without evicting active tasks", () => {
    const store = createTaskStore();
    const currentTime = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const completed = store.create("ctx-completed");
    store.completeNext(completed.contextId, "done");
    const active = store.create("ctx-active");

    clock.mockReturnValue(currentTime + 24 * 60 * 60 * 1000);

    expect(store.get(completed.id)).toBeUndefined();
    expect(store.get(active.id)).toBe(active);
  });
});
