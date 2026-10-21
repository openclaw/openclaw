import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
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

it.each([false, true])(
  "joins transport retirement (cleanup rejects: %s)",
  async (rejectCleanup) => {
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
      onRetire: vi.fn(async () => {
        retired.resolve();
        await cleanup.promise;
        if (rejectCleanup) {
          throw new Error("host cleanup failed");
        }
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
      taskPort.emit("message", {
        taskId: 1,
        nativeSections: new SharedArrayBuffer(4),
        taskContext,
      });
      await retired.promise;
      expect(host.installTaskContext).toHaveBeenCalledWith(taskContext);
      expectCalls(0, closeTask, parent.close);
      expect(process.exitCode).toBe(exitCode);
      const lateReceipt = { close: vi.fn() };
      taskPort.emit("message", { taskId: 2 });
      taskPort.emit("message", { closeResource: true, resourcePort: lateReceipt });
      expectCalls(1, lateReceipt.close, handler, host.onMessage);
      cleanup.resolve();
      await closed.promise;
      expectCalls(1, host.onRetire, closeTask, parent.close);
      expectCalls(0, taskMessages, parent.postMessage, host.onIdle);
      expect(process.exitCode).toBe(1);
    } finally {
      cleanup.resolve();
      if (host.onRetire.mock.calls.length > 0) {
        await closed.promise;
      }
      taskPort.close();
      peer.close();
    }
  },
);

function expectCalls(count: number, ...mocks: Array<{ mock: { calls: unknown[] } }>) {
  for (const mock of mocks) {
    expect(mock.mock.calls).toHaveLength(count);
  }
}
