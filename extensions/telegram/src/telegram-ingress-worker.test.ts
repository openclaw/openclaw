import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const workerHarness = vi.hoisted(() => ({
  instances: [] as unknown[],
  constructArgs: [] as unknown[][],
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  return {
    Worker: class extends EventEmitter {
      postMessage = vi.fn();
      terminate = vi.fn(async () => 1);

      constructor(...args: unknown[]) {
        super();
        workerHarness.instances.push(this);
        workerHarness.constructArgs.push(args);
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
    spoolDir: "/tmp/openclaw-telegram-worker-test",
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
    workerHarness.constructArgs.length = 0;
  });

  it("preserves cooperative worker shutdown", async () => {
    vi.useFakeTimers();
    const { handle, worker } = createWorker();

    const stopping = handle.stop();
    worker.emit("exit", 0);
    await stopping;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "stop" });
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

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "stop" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe("createTelegramIngressWorker module resolution", () => {
  afterEach(() => {
    workerHarness.instances.length = 0;
    workerHarness.constructArgs.length = 0;
  });

  // Regression: the source checkout loads this module as TypeScript, where a
  // hardcoded sibling `./telegram-ingress-worker.runtime.js` never exists.
  it("resolves the worker to a module that exists on disk", () => {
    createWorker();

    const [workerUrl] = workerHarness.constructArgs.at(-1) ?? [];
    expect(workerUrl).toBeInstanceOf(URL);
    const url = workerUrl as URL;
    expect(url.protocol).toBe("file:");

    const entry = fileURLToPath(url);
    // Under source mode this must land on the real .ts module, not a phantom .js.
    expect(entry.endsWith("telegram-ingress-worker.runtime.ts")).toBe(true);
    expect(existsSync(entry)).toBe(true);
  });

  it("passes the tsx preload so a TypeScript worker entry can load", () => {
    createWorker();

    const [, options] = workerHarness.constructArgs.at(-1) ?? [];
    const execArgv = (options as { execArgv?: string[] } | undefined)?.execArgv ?? [];

    // Worker.execArgv carries loader flags only; the entry comes from the URL.
    expect(execArgv[0]).toBe("--import");
    expect(execArgv).toHaveLength(2);
    expect(execArgv[1]).toContain("tsx");
    expect(execArgv).not.toContain(fileURLToPath(new URL(import.meta.url)));
  });

  // Regression: the packaged install must reach the dist-root entry tsdown emits
  // (`dist/telegram-ingress-worker.runtime.js`), not a sibling of the plugin dir.
  // QA smoke caught the wrong shape as "Cannot find module .../dist/extensions/
  // telegram/telegram-ingress-worker.runtime.js".
  it("resolves the packaged entry at the package dist root", () => {
    const distUrl = resolveRuntimeWorkerUrl({
      currentModuleUrl: new URL("../../../dist/extensions/telegram/index.js", import.meta.url).href,
      sourceWorkerName: "telegram-ingress-worker.runtime",
      distWorkerPath: "telegram-ingress-worker.runtime.js",
    });

    const entry = fileURLToPath(distUrl);
    expect(entry.endsWith(`${sep}dist${sep}telegram-ingress-worker.runtime.js`)).toBe(true);
    // Guard the regression shape: it must not be nested under the plugin dir.
    expect(entry).not.toContain(`${sep}dist${sep}extensions${sep}`);
  });
});
