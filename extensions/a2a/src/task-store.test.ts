import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A2aTaskStore } from "./task-store.js";
import { createTerminalStoreFixture } from "./task-store.test-support.js";

describe("A2A task store", () => {
  let store: A2aTaskStore;
  const create = (message: string, owner = "alice") => store.create(`ctx-${owner}`, owner, message);
  beforeEach(() => {
    store = new A2aTaskStore(createTerminalStoreFixture());
  });
  afterEach(async () => {
    await store.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("completes empty replies without inventing an artifact", async () => {
    expect(await store.complete(create("empty").id, undefined)).toMatchObject({
      status: {
        state: "TASK_STATE_COMPLETED",
        message: { role: "ROLE_AGENT", parts: [{ text: "Agent completed without reply text" }] },
      },
      artifacts: [],
    });
  });

  it("records bounded failures and policy rejections without consuming sibling replies", async () => {
    const failed = create("failed");
    const rejected = create("rejected");
    const active = create("active");

    expect(await store.fail(failed.id, new Error(`${"x".repeat(511)}😀tail`))).toMatchObject({
      status: { state: "TASK_STATE_FAILED", message: { parts: [{ text: "x".repeat(511) }] } },
    });
    expect(await store.reject(rejected.id, "peer blocked")).toMatchObject({
      status: { state: "TASK_STATE_REJECTED", message: { parts: [{ text: "peer blocked" }] } },
    });
    expect((await store.complete(active.id, "active reply"))?.id).toBe(active.id);
  });

  it("fails outstanding HTTP waits on shutdown", async () => {
    const task = create("shutdown");
    store.start(task.id);
    const waiting = store.wait(task, 120_000);

    await store.stop();

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

    await store.complete(task.id, "final reply");
    await expect(second).resolves.toBe(task);
    expect(timedOut?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.artifacts[0]?.parts).toEqual([{ text: "final reply" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts the oldest completed tasks after the 500-entry retention cap", async () => {
    const completedIds: string[] = [];
    for (let index = 0; index <= 500; index += 1) {
      const task = create(`message-${index}`);
      completedIds.push(task.id);
      await store.complete(task.id, "done");
    }

    expect(store.get(completedIds[0]!, "alice")).toBeUndefined();
    expect(store.get(completedIds[1]!, "alice")).toBeDefined();
    expect(store.get(completedIds[500]!, "alice")).toBeDefined();
    expect(create("message-0").id).not.toBe(completedIds[0]);
  });

  it("expires completed tasks after 24 hours without evicting active tasks", async () => {
    const currentTime = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const completed = create("expired-message");
    await store.complete(completed.id, "done");
    const active = create("active");

    clock.mockReturnValue(currentTime + 24 * 60 * 60 * 1000);

    expect(store.get(completed.id, "alice")).toBeUndefined();
    expect(store.get(active.id, "alice")).toBe(active);
    expect(create("expired-message").id).not.toBe(completed.id);
  });
});

describe("A2A terminal recovery", () => {
  it("restores terminal results and peer-scoped deduplication without reviving active inference", async () => {
    const durable = createTerminalStoreFixture();
    const first = new A2aTaskStore(durable);
    const completed = first.create("ctx", "alice", "done");
    const failed = first.create("ctx", "alice", "failed");
    const active = first.create("ctx", "alice", "active");
    first.start(active.id);
    await first.complete(completed.id, "answer");
    await first.fail(failed.id, "provider failed");

    const reopened = new A2aTaskStore(durable);
    await reopened.restore();
    expect(reopened.get(completed.id, "alice")).toEqual(completed);
    expect(reopened.get(failed.id, "alice")).toEqual(failed);
    expect(reopened.get(completed.id, "bob")).toBeUndefined();
    expect(reopened.get(active.id, "alice")).toBeUndefined();
    expect(reopened.create("different-context", "alice", "done").id).toBe(completed.id);
    expect(reopened.create("ctx", "bob", "done").id).not.toBe(completed.id);
  });

  it("keeps the original expiry and finish-order cap after reopening", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const durable = createTerminalStoreFixture();
      const first = new A2aTaskStore(durable);
      const tasks = Array.from({ length: 501 }, (_, index) =>
        first.create("ctx", "alice", `${index}`),
      );
      // Reverse creation order while every finish shares one millisecond.
      for (const task of tasks.toReversed()) {
        await first.complete(task.id, task.id);
      }
      const reopened = new A2aTaskStore(durable);
      await reopened.restore();
      expect(reopened.get(tasks[500]!.id, "alice")).toBeUndefined();
      expect(reopened.get(tasks[499]!.id, "alice")).toBeDefined();
      expect(reopened.get(tasks[0]!.id, "alice")).toBeDefined();
      clock.mockReturnValue(1_800_000_000_000 + 24 * 60 * 60 * 1000);
      const expired = new A2aTaskStore(durable);
      await expired.restore();
      expect(expired.get(tasks[0]!.id, "alice")).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it("does not publish or resolve waiters before persistence, and joins it on stop", async () => {
    const durable = createTerminalStoreFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const register = durable.register;
    durable.register = async (...args) => {
      await gate;
      await register(...args);
    };
    const store = new A2aTaskStore(durable);
    const task = store.create("ctx", "alice", "stalled");
    store.start(task.id);
    const waiting = store.wait(task, 120_000);
    const completed = store.complete(task.id, "answer");
    const stopped = vi.fn();
    const stopping = store.stop().then(stopped);
    await Promise.resolve();
    expect(task.status.state).toBe("TASK_STATE_WORKING");
    expect(store.get(task.id, "alice")?.artifacts).toEqual([]);
    expect(stopped).not.toHaveBeenCalled();
    release();
    await expect(completed).resolves.toMatchObject({ status: { state: "TASK_STATE_COMPLETED" } });
    await expect(waiting).resolves.toMatchObject({ status: { state: "TASK_STATE_COMPLETED" } });
    await stopping;
    const reopened = new A2aTaskStore(durable);
    await reopened.restore();
    expect(reopened.get(task.id, "alice")?.artifacts[0]?.parts).toEqual([{ text: "answer" }]);
  });

  it("never overwrites a possibly committed result after losing the write acknowledgement", async () => {
    const durable = createTerminalStoreFixture();
    const register = vi.spyOn(durable, "register").mockImplementation(async (...args) => {
      // Simulate the worker committing and losing only its acknowledgement.
      const [key, value] = args;
      durable.rows.set(key, { key, value: structuredClone(value), createdAt: Date.now() });
      throw new Error("acknowledgement lost");
    });
    const store = new A2aTaskStore(durable);
    const task = store.create("ctx", "alice", "ambiguous");
    await expect(store.complete(task.id, "real answer")).rejects.toThrow("acknowledgement lost");
    await expect(store.fail(task.id, "synthetic failure")).rejects.toThrow("acknowledgement lost");
    await expect(store.stop()).rejects.toThrow("acknowledgement lost");
    expect(register).toHaveBeenCalledTimes(1);
    const reopened = new A2aTaskStore(durable);
    await reopened.restore();
    expect(reopened.get(task.id, "alice")?.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("refuses persisted nonterminal or unknown states before accepting reads", async () => {
    const durable = createTerminalStoreFixture();
    const first = new A2aTaskStore(durable);
    const task = first.create("ctx", "alice", "invalid");
    await first.complete(task.id, "answer");
    for (const state of ["TASK_STATE_WORKING", "unknown"]) {
      for (const row of durable.rows.values()) {
        Reflect.set(row.value.task.status, "state", state);
      }
      await expect(new A2aTaskStore(durable).restore()).rejects.toThrow("Invalid persisted");
    }
  });
});
