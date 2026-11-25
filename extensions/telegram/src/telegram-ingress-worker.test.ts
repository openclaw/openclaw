import { existsSync } from "node:fs";
import type { WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

const workerHarness = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const instances: MockWorker[] = [];
  class MockWorker extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => 1);
    constructor(
      public url: URL,
      public options: WorkerOptions,
    ) {
      super();
      instances.push(this);
    }
  }
  return { instances, MockWorker };
});

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: workerHarness.MockWorker,
}));

import { createTelegramIngressWorker } from "./telegram-ingress-worker.js";

function createWorker() {
  vi.useFakeTimers();
  const handle = createTelegramIngressWorker({
    token: "123456:test",
    accountId: "default",
    initialUpdateId: null,
  });
  return { handle, worker: workerHarness.instances.at(-1)! };
}

describe("stopTelegramIngressWorker", () => {
  afterEach(() => {
    vi.useRealTimers();
    workerHarness.instances.length = 0;
  });

  it("starts from an existing source entry with runtime-appropriate TypeScript support", () => {
    const { handle, worker } = createWorker();

    expect(existsSync(worker.url)).toBe(true);
    expect(worker.options.execArgv).toEqual(
      process.versions.bun ? ["--no-install"] : ["--import", expect.stringContaining("tsx")],
    );
    const onMessage = vi.fn();
    const message = { type: "spooled", updateId: 42, queued: 1 };
    handle.onMessage = onMessage;
    worker.emit("message", message);
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(message);
    handle.onMessage = undefined;
    worker.emit("message", message);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it.each([true, false])("stops within budget (cooperative=%s)", async (cooperative) => {
    const { handle, worker } = createWorker();
    const stopping = handle.stop();
    if (cooperative) {
      worker.emit("exit", 0);
      await stopping;
      await vi.advanceTimersByTimeAsync(2_000);
    } else {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
    }
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "stop" }, []);
    expect(worker.terminate).toHaveBeenCalledTimes(cooperative ? 0 : 1);
  });
});
