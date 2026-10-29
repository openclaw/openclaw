import { AsyncLocalStorage } from "node:async_hooks";
import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

const workerHarness = vi.hoisted(() => ({
  instances: [] as unknown[],
  entries: [] as { url: URL; options: WorkerOptions }[],
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  const actual = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
  return {
    ...actual,
    Worker: class extends EventEmitter {
      postMessage = vi.fn();
      terminate = vi.fn(async () => 1);

      constructor(url: URL, options: WorkerOptions) {
        super();
        workerHarness.entries.push({ url, options });
        workerHarness.instances.push(this);
      }
    },
  };
});

import { createTelegramIngressWorker } from "./telegram-ingress-worker.js";

type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
};

function createWorker(): {
  handle: ReturnType<typeof createTelegramIngressWorker>;
  worker: FakeWorker;
} {
  const handle = createTelegramIngressWorker({
    token: "123456:test",
    accountId: "default",
    initialUpdateId: null,
  });
  const worker = workerHarness.instances.at(-1) as FakeWorker | undefined;
  if (!worker) {
    throw new Error("expected Telegram ingress worker");
  }
  return { handle, worker };
}

describe("stopTelegramIngressWorker", () => {
  afterEach(() => {
    vi.useRealTimers();
    workerHarness.instances.length = 0;
    workerHarness.entries.length = 0;
  });

  it("starts from an existing source entry with runtime-appropriate TypeScript support", () => {
    createWorker();

    const entry = workerHarness.entries.at(-1)!;
    expect(existsSync(entry.url)).toBe(true);
    expect(entry.options.execArgv).toEqual(
      process.versions.bun ? ["--no-install"] : ["--import", expect.stringContaining("tsx")],
    );
  });

  it("keeps late subscriptions in the construction owner and preserves unsubscribe/ACK", () => {
    const scope = new AsyncLocalStorage<string>();
    const { handle, worker } = scope.run("construction-owner", createWorker);
    const owners: Array<string | undefined> = [];
    const unsubscribe = scope.run("registration-owner", () =>
      handle.onMessage(() => owners.push(scope.getStore())),
    );
    const message = { type: "spooled", updateId: 7, queued: 1 };
    scope.run("emission-owner", () => worker.emit("message", message));
    expect(owners).toEqual(["construction-owner"]);
    unsubscribe();
    scope.run("emission-owner", () => worker.emit("message", message));
    expect(owners).toEqual(["construction-owner"]);
    handle.ackSpooledUpdate?.("request-7", { ok: true, updateId: 7 });
    expect(worker.postMessage).toHaveBeenCalledWith(
      { type: "spool-ack", requestId: "request-7", result: { ok: true, updateId: 7 } },
      [],
    );
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error("already exited");
    });
    expect(() =>
      handle.ackSpooledUpdate?.("request-8", { ok: false, message: "retry" }),
    ).not.toThrow();
  });

  it("reports a worker error and permits cooperative cleanup afterwards", async () => {
    const { handle, worker } = createWorker();
    const failed = expect(handle.task()).rejects.toThrow("worker fixture failure");
    worker.emit("error", new Error("worker fixture failure"));
    await failed;
    await handle.stop();
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("preserves cooperative worker shutdown", async () => {
    vi.useFakeTimers();
    const { handle, worker } = createWorker();

    const stopping = handle.stop();
    worker.emit("exit", 0);
    await stopping;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "stop" }, []);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("terminates a non-cooperative worker inside the channel stop budget", async () => {
    vi.useFakeTimers();
    const { handle, worker } = createWorker();

    const stopping = handle.stop();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(worker.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "stop" }, []);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
