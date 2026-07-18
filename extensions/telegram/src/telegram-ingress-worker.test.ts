// Telegram ingress worker handle tests cover lifecycle edge cases.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramIngressWorkerCommand } from "./telegram-ingress-worker.js";

const workerMocks = vi.hoisted(() => {
  const instances: Array<
    EventEmitter & { terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }
  > = [];
  const Worker = vi.fn();
  return { instances, Worker };
});

vi.mock("node:worker_threads", () => ({
  Worker: workerMocks.Worker,
}));

describe("createTelegramIngressWorker stop", () => {
  beforeEach(async () => {
    workerMocks.instances.length = 0;
    workerMocks.Worker.mockImplementation(function MockWorker(this: unknown) {
      const worker = new EventEmitter() as EventEmitter & {
        terminate: ReturnType<typeof vi.fn>;
        postMessage: ReturnType<typeof vi.fn>;
      };
      worker.terminate = vi.fn(async () => {
        worker.emit("exit", 0);
      });
      worker.postMessage = vi.fn((message: TelegramIngressWorkerCommand) => {
        if (message.type === "stop") {
          worker.emit("exit", 0);
        }
      });
      workerMocks.instances.push(worker);
      return worker;
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadFactory() {
    const { createTelegramIngressWorker } = await import("./telegram-ingress-worker.js");
    return createTelegramIngressWorker;
  }

  it("is idempotent and returns the same promise on repeated calls", async () => {
    const createTelegramIngressWorker = await loadFactory();
    const handle = createTelegramIngressWorker({
      token: "test:token",
      accountId: "acct",
      initialUpdateId: null,
      spoolDir: "/tmp/test",
    });

    const stop1 = handle.stop();
    const stop2 = handle.stop();
    expect(stop1).toBe(stop2);
    await Promise.all([stop1, stop2]);

    const worker = workerMocks.instances[0];
    expect(worker).toBeDefined();
    expect(worker!.postMessage).toHaveBeenCalledTimes(1);
    expect(worker!.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "stop" } satisfies TelegramIngressWorkerCommand),
    );
  });

  it("routes forced terminate rejections during stop timeout", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    workerMocks.Worker.mockImplementationOnce(function MockWorker(this: unknown) {
      const worker = new EventEmitter() as EventEmitter & {
        terminate: ReturnType<typeof vi.fn>;
        postMessage: ReturnType<typeof vi.fn>;
      };
      worker.terminate = vi.fn(async () => {
        worker.emit("exit", 0);
        throw new Error("already terminated");
      });
      worker.postMessage = vi.fn(() => {
        // Ignore graceful stop; force the timeout terminate path.
      });
      workerMocks.instances.push(worker);
      return worker;
    });

    try {
      const createTelegramIngressWorker = await loadFactory();
      const handle = createTelegramIngressWorker({
        token: "test:token",
        accountId: "acct",
        initialUpdateId: null,
        spoolDir: "/tmp/test",
      });

      vi.useFakeTimers();
      const stopPromise = handle.stop();
      vi.advanceTimersByTime(15_000);
      await stopPromise;
      await Promise.resolve();

      const worker = workerMocks.instances[0];
      expect(worker).toBeDefined();
      expect(worker!.terminate).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  it("does not leak unhandled rejections when terminate rejects", async () => {
    const createTelegramIngressWorker = await loadFactory();
    const handle = createTelegramIngressWorker({
      token: "test:token",
      accountId: "acct",
      initialUpdateId: null,
      spoolDir: "/tmp/test",
    });

    const worker = workerMocks.instances[0];
    worker!.terminate.mockRejectedValueOnce(new Error("already terminated"));

    // The stop timeout is 15s; simulate it firing immediately.
    vi.useFakeTimers();
    const stopPromise = handle.stop();
    vi.advanceTimersByTime(15_000);
    await stopPromise;
    vi.useRealTimers();

    expect(worker!.terminate).toHaveBeenCalledTimes(1);
  });
});
