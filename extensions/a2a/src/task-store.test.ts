import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A2aTaskStore } from "./task-store.js";

describe("A2A task store", () => {
  let store: A2aTaskStore;
  const create = (message: string, owner = "alice") => store.create(`ctx-${owner}`, owner, message);
  beforeEach(() => {
    store = new A2aTaskStore();
  });
  afterEach(() => {
    store.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("completes empty replies without inventing an artifact", () => {
    expect(store.complete(create("empty").id, undefined)).toMatchObject({
      status: {
        state: "TASK_STATE_COMPLETED",
        message: { role: "ROLE_AGENT", parts: [{ text: "Agent completed without reply text" }] },
      },
      artifacts: [],
    });
  });

  it("records bounded failures and policy rejections without consuming sibling replies", () => {
    const failed = create("failed");
    const rejected = create("rejected");
    const active = create("active");

    expect(store.fail(failed.id, new Error(`${"x".repeat(511)}😀tail`))).toMatchObject({
      status: { state: "TASK_STATE_FAILED", message: { parts: [{ text: "x".repeat(511) }] } },
    });
    expect(store.reject(rejected.id, "peer blocked")).toMatchObject({
      status: { state: "TASK_STATE_REJECTED", message: { parts: [{ text: "peer blocked" }] } },
    });
    expect(store.complete(active.id, "active reply")?.id).toBe(active.id);
  });

  it("fails outstanding HTTP waits on shutdown", async () => {
    const task = create("shutdown");
    store.start(task.id);
    const waiting = store.wait(task, 120_000);

    store.stop();

    await expect(waiting).resolves.toMatchObject({ status: { state: "TASK_STATE_FAILED" } });
    expect(store.get(task.id, "alice")).toBeUndefined();
  });

  it("keeps a later observer waiting after a sibling times out", async () => {
    vi.useFakeTimers();
    const task = create("observers");
    store.start(task.id);
    const first = store.wait(task, 10);
    await vi.advanceTimersByTimeAsync(5);
    const second = store.wait(task, 20);
    const secondSettled = vi.fn();
    void second.then(secondSettled);

    await vi.advanceTimersByTimeAsync(5);
    const timedOut = await first;
    expect(timedOut).toBe(task);
    expect(timedOut?.status.state).toBe("TASK_STATE_WORKING");
    expect(secondSettled).not.toHaveBeenCalled();

    store.complete(task.id, "final reply");
    await expect(second).resolves.toBe(task);
    expect(timedOut?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.artifacts[0]?.parts).toEqual([{ text: "final reply" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts the oldest completed tasks after the 500-entry retention cap", () => {
    const completedIds: string[] = [];
    for (let index = 0; index <= 500; index += 1) {
      const task = create(`message-${index}`);
      completedIds.push(task.id);
      store.complete(task.id, "done");
    }

    expect(store.get(completedIds[0]!, "alice")).toBeUndefined();
    expect(store.get(completedIds[1]!, "alice")).toBeDefined();
    expect(store.get(completedIds[500]!, "alice")).toBeDefined();
    expect(create("message-0").id).not.toBe(completedIds[0]);
  });

  it("expires completed tasks after 24 hours without evicting active tasks", () => {
    const currentTime = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const completed = create("expired-message");
    store.complete(completed.id, "done");
    const active = create("active");

    clock.mockReturnValue(currentTime + 24 * 60 * 60 * 1000);

    expect(store.get(completed.id, "alice")).toBeUndefined();
    expect(store.get(active.id, "alice")).toBe(active);
    expect(create("expired-message").id).not.toBe(completed.id);
  });
});
