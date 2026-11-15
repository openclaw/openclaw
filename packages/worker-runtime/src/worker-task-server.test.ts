import { EventEmitter, once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import {
  areWorkerNativeSectionsSettled,
  cancelWorkerNativeSections,
  createWorkerNativeSectionState,
} from "./worker-task-native-sections.js";
import { serveOwnedWorkerTasks } from "./worker-task-server.js";

const boundary = vi.hoisted((): { port: unknown } => ({ port: undefined }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get parentPort() {
    return boundary.port;
  },
}));
const exitCode = process.exitCode;
afterEach(() => {
  process.exitCode = exitCode;
});

it.each([false, true])("joins retirement (cleanup rejects: %s)", async (rejectCleanup) => {
  const retired = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const parent = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    close: vi.fn(() => closed.resolve()),
  });
  boundary.port = parent;
  const { port1: taskPort, port2: peer } = new MessageChannel();
  const closeTask = vi.spyOn(taskPort, "close");
  const taskMessages = vi.spyOn(taskPort, "postMessage");
  const host = {
    selectStartupPort: (message: unknown) => (message === "startup" ? taskPort : undefined),
    initialize: vi.fn(),
    onReady: vi.fn(),
    onMessage: vi.fn(),
    onIdle: vi.fn(),
    installTaskContext: vi.fn(),
    onRetire: vi.fn(() => {
      retired.resolve();
      return cleanup.promise;
    }),
  };
  const handler = vi.fn(() => {
    throw new Error("terminal native failure");
  });
  try {
    serveOwnedWorkerTasks(handler, { retireOnError: true, closeResource: vi.fn() }, host);
    parent.emit("message", "startup");
    expect(host.initialize.mock.calls).toEqual([[parent], [taskPort]]);
    expect(host.onReady).toHaveBeenCalledTimes(2);
    expect(parent.listenerCount("message")).toBe(0);
    const taskContext = ["captured context"];
    taskPort.emit("message", { taskId: 1, nativeSections: new SharedArrayBuffer(4), taskContext });
    await retired.promise;
    expect(host.installTaskContext).toHaveBeenCalledWith(taskContext);
    expect(callCounts(closeTask, parent.close)).toEqual([0, 0]);
    expect(process.exitCode).toBe(exitCode);
    const lateReceipt = { close: vi.fn() };
    taskPort.emit("message", { taskId: 2 });
    taskPort.emit("message", { closeResource: true, resourcePort: lateReceipt });
    expect(callCounts(lateReceipt.close, handler, host.onMessage)).toEqual([1, 1, 1]);
    if (rejectCleanup) {
      cleanup.reject(new Error("host cleanup failed"));
    } else {
      cleanup.resolve();
    }
    await closed.promise;
    expect(callCounts(host.onRetire, closeTask, parent.close)).toEqual([1, 1, 1]);
    expect(callCounts(taskMessages, parent.postMessage, host.onIdle)).toEqual([0, 0, 0]);
    expect(process.exitCode).toBe(1);
  } finally {
    cleanup.resolve();
    if (host.onRetire.mock.calls.length > 0) {
      await closed.promise;
    }
    taskPort.close();
    peer.close();
  }
});

const callCounts = (...mocks: Array<{ mock: { calls: unknown[] } }>) =>
  mocks.map(({ mock }) => mock.calls.length);

it("cancels noninteractive owned work and joins cleanup before releasing native custody", async () => {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<void>();
  const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  boundary.port = parent;
  const sections = createWorkerNativeSectionState();
  serveOwnedWorkerTasks(
    (_input, _channel, control) =>
      control.runNativeSection(async () => {
        control.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
        started.resolve();
        await cancelled.promise;
        await cleanup.promise;
        control.signal.throwIfAborted();
      }),
    { closeResource: vi.fn() },
    {
      initialize: vi.fn(),
      onMessage: vi.fn(),
      installTaskContext: vi.fn(),
      onIdle: () => idle.resolve(),
    },
  );
  parent.emit("message", { taskId: 1, nativeSections: sections.buffer });
  try {
    await started.promise;
    cancelWorkerNativeSections(sections);
    await cancelled.promise;
    expect(areWorkerNativeSectionsSettled(sections)).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
  } finally {
    cleanup.resolve();
    await idle.promise;
  }
  expect(areWorkerNativeSectionsSettled(sections)).toBe(true);
  expect(parent.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ status: "failed", taskId: 1, error: "worker task cancelled" }),
    [],
  );
});

it("preserves transferred results, failures, and resource ordering for synchronous stateless tasks", async () => {
  const { port1: output, port2: replies } = new MessageChannel();
  const { port1: beforeReceipt, port2: beforeReply } = new MessageChannel();
  const { port1: afterReceipt, port2: afterReply } = new MessageChannel();
  const parent = Object.assign(new EventEmitter(), {
    postMessage: output.postMessage.bind(output),
  });
  boundary.port = parent;
  const enteredClose = Promise.withResolvers<void>();
  const finishClose = Promise.withResolvers<void>();
  const order: string[] = [];
  let produced: Uint8Array<ArrayBuffer> | undefined;
  serveOwnedWorkerTasks<Uint8Array<ArrayBuffer>, undefined, string>(
    {
      synchronousStateless(input) {
        order.push(`task:${input}`);
        if (input === "fail") {
          throw new Error("synthetic read failure");
        }
        produced = new Uint8Array([1, 2, 3]);
        return produced;
      },
    },
    {
      transferList: (value) => [value.buffer],
      closeResource: async (key) => {
        order.push(`close:${key}`);
        if (key === "before") {
          enteredClose.resolve();
          await finishClose.promise;
        }
        order.push(`closed:${key}`);
      },
    },
    {
      initialize: vi.fn(),
      onMessage: vi.fn(),
      installTaskContext: vi.fn(),
      onIdle: vi.fn(),
    },
  );
  const task = (taskId: number, input: string) => {
    const reply = once(replies, "message");
    parent.emit("message", { taskId, input, nativeSections: new SharedArrayBuffer(4) });
    return reply;
  };
  const success = (taskId: number) => [{ status: "ok", taskId, value: new Uint8Array([1, 2, 3]) }];
  try {
    expect(await task(1, "first")).toEqual(success(1));
    expect(produced?.byteLength).toBe(0);
    expect(await task(2, "fail")).toEqual([
      { status: "failed", taskId: 2, error: "synthetic read failure" },
    ]);
    const beforeClosed = once(beforeReply, "message");
    parent.emit("message", { closeResource: true, key: "before", resourcePort: beforeReceipt });
    await enteredClose.promise;
    const waiting = task(3, "waiting");
    const afterClosed = once(afterReply, "message");
    parent.emit("message", { closeResource: true, key: "after", resourcePort: afterReceipt });
    expect(order).toEqual(["task:first", "task:fail", "close:before"]);
    finishClose.resolve();
    expect(await beforeClosed).toEqual([{ ok: true }]);
    expect(await waiting).toEqual(success(3));
    expect(await afterClosed).toEqual([{ ok: true }]);
    expect(await task(4, "last")).toEqual(success(4));
    expect(order).toEqual([
      "task:first",
      "task:fail",
      "close:before",
      "closed:before",
      "task:waiting",
      "close:after",
      "closed:after",
      "task:last",
    ]);
  } finally {
    finishClose.resolve();
    for (const port of [output, replies, beforeReceipt, beforeReply, afterReceipt, afterReply]) {
      port.close();
    }
  }
});
