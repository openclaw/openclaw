import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { A2aTaskStore } from "./task-store.js";
import {
  createPendingStoreFixture,
  createTerminalStoreFixture,
} from "./task-store.test-support.js";
import { streamA2aTask } from "./task-stream.js";

afterEach(() => vi.useRealTimers());

async function fixture(isCurrent = () => true) {
  vi.useFakeTimers();
  const store = new A2aTaskStore(createTerminalStoreFixture(), createPendingStoreFixture());
  const task = store.create("slow-context", "peer", "original-message");
  await store.start(task.id);
  const response = new ServerResponse(new IncomingMessage(new Socket()));
  vi.spyOn(response, "flushHeaders").mockImplementation(() => {});
  const write = vi.spyOn(response, "write").mockReturnValue(false);
  vi.spyOn(response, "end").mockImplementation(() => {
    response.emit("finish");
    return response;
  });
  const destroy = vi.spyOn(response, "destroy").mockImplementation(() => {
    response.emit("close");
    return response;
  });
  const controller = new AbortController();
  const release = vi.fn();
  streamA2aTask({
    response,
    id: "subscribe",
    task,
    store,
    signal: controller.signal,
    isCurrent,
    release,
  });
  return { store, task, response, write, destroy, controller, release };
}

it("coalesces blocked writes into the latest original Task and retains its final result", async () => {
  const { store, task, response, write, release } = await fixture();
  for (let index = 0; index < 1000; index++) {
    store.update(task.id, `native snapshot ${index}`);
  }
  await store.complete(task.id, "recorded final");
  expect(write).toHaveBeenCalledOnce();
  write.mockReturnValue(true);
  response.emit("drain");
  expect(write).toHaveBeenCalledTimes(2);
  const snapshot = JSON.parse(String(write.mock.calls[1]![0]).slice("data: ".length).trim());
  expect(snapshot.result.task).toMatchObject({
    id: task.id,
    status: { state: "TASK_STATE_COMPLETED" },
    artifacts: [{ parts: [{ text: "recorded final" }] }],
  });
  expect(release).toHaveBeenCalledOnce();
  response.emit("close");
  expect(release).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await store.stop();
});

it.each(["disconnect", "deadline", "revocation"])(
  "releases a %s subscription without cancelling execution",
  async (kind) => {
    let current = true;
    const { store, task, response, write, release } = await fixture(() => current);
    if (kind === "disconnect") {
      response.emit("close");
    } else if (kind === "deadline") {
      await vi.advanceTimersByTimeAsync(120_000);
    } else {
      store.update(task.id, "private preview waiting for drain");
      current = false;
      response.emit("drain");
    }
    expect(release).toHaveBeenCalledOnce();
    store.update(task.id, "native output after subscription ended");
    await store.complete(task.id, "final after disconnect");
    expect(write).toHaveBeenCalledOnce();
    expect(store.get(task.id, "peer")).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "final after disconnect" }] }],
    });
    expect(vi.getTimerCount()).toBe(0);
    await store.stop();
  },
);

it("retracts a provisional artifact when the native final has no reply text", async () => {
  const { store, task, response, write, release } = await fixture();
  write.mockReturnValue(true);
  response.emit("drain");
  store.update(task.id, "provisional text");
  await store.complete(task.id, undefined);
  const finalFrame = String(write.mock.calls.at(-1)![0]);
  const final = JSON.parse(finalFrame.slice("data: ".length).trim()).result.task;
  expect(final).toMatchObject({
    id: task.id,
    status: { state: "TASK_STATE_COMPLETED" },
    artifacts: [],
  });
  expect(release).toHaveBeenCalledOnce();
  await store.stop();
});
