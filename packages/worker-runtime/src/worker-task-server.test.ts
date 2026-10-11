import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { serveOwnedWorkerTasks } from "./worker-task-server.js";

const boundary = vi.hoisted(() => {
  const port: unknown = undefined;
  return { port };
});
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
  "joins retained transport retirement when its host cleanup rejects: %s",
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
    const initialize = vi.fn();
    const onReady = vi.fn();
    const onMessage = vi.fn();
    const onIdle = vi.fn();
    const installTaskContext = vi.fn();
    const handler = vi.fn(() => {
      throw new Error("terminal native failure");
    });
    const onRetire = vi.fn(async () => {
      retired.resolve();
      await cleanup.promise;
      if (rejectCleanup) {
        throw new Error("host cleanup failed");
      }
    });
    try {
      serveOwnedWorkerTasks(
        handler,
        { retireOnError: true },
        {
          selectStartupPort: (message) => (message === "startup" ? taskPort : undefined),
          initialize,
          onReady,
          onMessage,
          installTaskContext,
          onIdle,
          onRetire,
        },
      );
      parent.emit("message", "startup");
      expect(initialize.mock.calls).toEqual([[parent], [taskPort]]);
      expect(onReady).toHaveBeenCalledTimes(2);
      expect(parent.listenerCount("message")).toBe(0);
      const taskContext = ["captured context"];
      taskPort.emit("message", {
        taskId: 1,
        nativeSections: new SharedArrayBuffer(4),
        taskContext,
      });
      await retired.promise;
      expect(installTaskContext).toHaveBeenCalledWith(taskContext);
      expect(closeTask).not.toHaveBeenCalled();
      expect(parent.close).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(exitCode);
      const lateReceipt = { close: vi.fn() };
      taskPort.emit("message", { taskId: 2 });
      taskPort.emit("message", { closeResource: true, resourcePort: lateReceipt });
      expect(lateReceipt.close).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledOnce();
      expect(onMessage).toHaveBeenCalledOnce();
      cleanup.resolve();
      await closed.promise;
      expect(onRetire).toHaveBeenCalledOnce();
      expect(closeTask).toHaveBeenCalledOnce();
      expect(parent.close).toHaveBeenCalledOnce();
      expect(taskMessages).not.toHaveBeenCalled();
      expect(parent.postMessage).not.toHaveBeenCalled();
      expect(onIdle).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      cleanup.resolve();
      if (onRetire.mock.calls.length > 0) {
        await closed.promise;
      }
      taskPort.close();
      peer.close();
    }
  },
);
