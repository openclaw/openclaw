import { EventEmitter } from "node:events";
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
