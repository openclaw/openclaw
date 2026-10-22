import { afterEach, describe, expect, it, vi } from "vitest";
import { A2aTaskStore, type A2aStreamResponse } from "./task-store.js";

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

  it("correlates concurrent replies by task identity without cross-talk", () => {
    const store = createTaskStore();
    const aliceFirst = store.create("ctx-alice", "alice", "first");
    const bobOnly = store.create("ctx-bob", "bob", "only");
    const aliceSecond = store.create("ctx-alice", "alice", "second");
    for (const task of [aliceFirst, bobOnly, aliceSecond]) {
      store.start(task.id);
    }

    expect(store.complete(aliceFirst.id, "first")?.id).toBe(aliceFirst.id);
    expect(store.complete(bobOnly.id, "bob")?.id).toBe(bobOnly.id);
    expect(store.complete(aliceSecond.id, "second")?.id).toBe(aliceSecond.id);
    expect(aliceFirst.artifacts[0]?.parts).toEqual([{ text: "first" }]);
    expect(aliceSecond.artifacts[0]?.parts).toEqual([{ text: "second" }]);
  });

  it("completes empty replies without inventing an artifact", () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice", "alice", "empty");

    expect(store.complete(task.id, undefined)).toMatchObject({
      status: {
        state: "TASK_STATE_COMPLETED",
        message: { role: "ROLE_AGENT", parts: [{ text: "Agent completed without reply text" }] },
      },
      artifacts: [],
    });
  });

  it("records bounded failures and policy rejections without consuming sibling replies", () => {
    const store = createTaskStore();
    const failed = store.create("ctx-alice", "alice", "failed");
    const rejected = store.create("ctx-alice", "alice", "rejected");
    const active = store.create("ctx-alice", "alice", "active");

    expect(store.fail(failed.id, new Error(`${"x".repeat(511)}😀tail`))).toMatchObject({
      status: { state: "TASK_STATE_FAILED", message: { parts: [{ text: "x".repeat(511) }] } },
    });
    expect(store.reject(rejected.id, "peer blocked")).toMatchObject({
      status: { state: "TASK_STATE_REJECTED", message: { parts: [{ text: "peer blocked" }] } },
    });
    expect(store.complete(active.id, "active reply")?.id).toBe(active.id);
  });

  it("returns working tasks after timeout and accepts the eventual final reply", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice", "alice", "late");
    store.start(task.id);

    await expect(store.wait(task, 0)).resolves.toMatchObject({
      status: { state: "TASK_STATE_WORKING" },
    });
    expect(store.complete(task.id, "late reply")).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "late reply" }] }],
    });
  });

  it("fails outstanding HTTP waits on shutdown", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice", "alice", "shutdown");
    store.start(task.id);
    const waiting = store.wait(task, 120_000);

    store.stop();

    await expect(waiting).resolves.toMatchObject({ status: { state: "TASK_STATE_FAILED" } });
    expect(store.get(task.id, "alice")).toBeUndefined();
  });

  it("keeps a later observer waiting after a sibling times out", async () => {
    vi.useFakeTimers();
    try {
      const store = createTaskStore();
      const task = store.create("ctx-alice", "alice", "observers");
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest completed tasks after the 500-entry retention cap", () => {
    const store = createTaskStore();
    const completedIds: string[] = [];
    for (let index = 0; index <= 500; index += 1) {
      const contextId = `ctx-${index}`;
      const task = store.create(contextId, "alice", `message-${index}`);
      completedIds.push(task.id);
      store.complete(task.id, "done");
    }

    expect(store.get(completedIds[0]!, "alice")).toBeUndefined();
    expect(store.get(completedIds[1]!, "alice")).toBeDefined();
    expect(store.get(completedIds[500]!, "alice")).toBeDefined();
    expect(store.create("ctx-0", "alice", "message-0").id).not.toBe(completedIds[0]);
  });

  it("expires completed tasks after 24 hours without evicting active tasks", () => {
    const store = createTaskStore();
    const currentTime = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const completed = store.create("ctx-completed", "alice", "expired-message");
    store.complete(completed.id, "done");
    const active = store.create("ctx-active", "alice", "active");

    clock.mockReturnValue(currentTime + 24 * 60 * 60 * 1000);

    expect(store.get(completed.id, "alice")).toBeUndefined();
    expect(store.get(active.id, "alice")).toBe(active);
    expect(store.create("ctx-completed", "alice", "expired-message").id).not.toBe(completed.id);
  });

  it("gives concurrent subscribers independent queues with the full event sequence", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-stream", "alice");
    const first = store.stream(task.id, "alice");
    const second = store.stream(task.id, "alice");
    // Consume each snapshot frame so both streams are parked on their own queue.
    await first.next();
    await second.next();

    store.start(task.id);
    store.complete(task.id, "done");

    const drain = async (iterator: AsyncGenerator<A2aStreamResponse>) => {
      const states: string[] = [];
      for await (const frame of iterator) {
        if ("statusUpdate" in frame && frame.statusUpdate) {
          states.push(frame.statusUpdate.status.state);
        }
      }
      return states;
    };
    // A shared queue would hand each frame to whichever stream raced ahead;
    // per-subscriber queues must deliver the whole sequence to both.
    await expect(drain(first)).resolves.toEqual(["TASK_STATE_WORKING", "TASK_STATE_COMPLETED"]);
    await expect(drain(second)).resolves.toEqual(["TASK_STATE_WORKING", "TASK_STATE_COMPLETED"]);
  });

  it("replays transitions that happened before a subscriber attached", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-replay", "alice");
    store.start(task.id);
    store.complete(task.id, "done");

    const states: string[] = [];
    for await (const frame of store.stream(task.id, "alice")) {
      if ("statusUpdate" in frame && frame.statusUpdate) {
        states.push(frame.statusUpdate.status.state);
      }
    }
    // The snapshot carries the final state; the replay buffer must still
    // deliver the transitions the task already went through.
    expect(states).toContain("TASK_STATE_WORKING");
    expect(states).toContain("TASK_STATE_COMPLETED");
  });

  it("does not regress the state sequence when a reused messageId lands on a completed task", async () => {
    const store = createTaskStore();
    const first = store.create("ctx-dup", "alice", "reused-message");
    store.start(first.id);
    store.complete(first.id, "done");

    // Same (ownerPeer, messageId) idempotently returns the completed task.
    const second = store.create("ctx-dup", "alice", "reused-message");
    expect(second.id).toBe(first.id);

    const frames: A2aStreamResponse[] = [];
    for await (const frame of store.stream(second.id, "alice")) {
      frames.push(frame);
    }
    const states = frames
      .filter(
        (frame): frame is { task: never; statusUpdate: { status: { state: string } } } =>
          "statusUpdate" in frame,
      )
      .map((frame) => frame.statusUpdate.status.state);

    // A completed-task snapshot yielded before the replayed events would put
    // COMPLETED before WORKING; the replay sequence must stand alone and stay
    // in generation order (STREAM-ORDER-001).
    expect(states).toEqual(["TASK_STATE_WORKING", "TASK_STATE_COMPLETED"]);
  });

  it("resolves a blocking wait when the task pauses for input", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-input", "alice");
    store.start(task.id);
    const waiting = store.wait(task, 120_000);

    store.requireInput(task.id, "What color?");

    // The peer must receive the question, so the blocked response resolves
    // with the interrupted task instead of waiting out the timeout.
    await expect(waiting).resolves.toMatchObject({
      status: { state: "TASK_STATE_INPUT_REQUIRED" },
    });
  });

  it("filters listed tasks by statusTimestampAfter", () => {
    const store = createTaskStore();
    // Status timestamps come from `new Date()`, so the clock itself must move
    // between the two tasks for the comparison to be strict.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const earlier = store.create("ctx-earlier", "alice", "m-earlier");
    store.complete(earlier.id, "done");
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    const later = store.create("ctx-later", "alice", "m-later");
    store.complete(later.id, "done");

    const listed = store.listTasks({
      ownerPeer: "alice",
      statusTimestampAfter: earlier.status.timestamp,
    });

    expect(listed.tasks.map((entry) => entry.id)).toEqual([later.id]);
    // Restore only after the assertions: with the clock back at the real date,
    // the 2026-01-01 completion times look older than the 24h retention and
    // the next prune would evict both fixtures.
    vi.useRealTimers();
  });

  it("notifies eviction observers when retention prunes a terminal task", () => {
    const store = createTaskStore();
    const evicted: Array<{ taskId: string; ownerPeer: string | undefined }> = [];
    store.onTaskEvicted(({ taskId, ownerPeer }) => evicted.push({ taskId, ownerPeer }));

    const first = store.create("ctx-first", "alice", "m-first");
    store.complete(first.id, "done");
    for (let index = 0; index < 500; index += 1) {
      const task = store.create(`ctx-${index}`, "alice", `m-${index}`);
      store.complete(task.id, "done");
    }

    expect(evicted).toContainEqual({ taskId: first.id, ownerPeer: "alice" });
  });
});
