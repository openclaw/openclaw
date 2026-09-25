import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorTelegramProvider } from "./monitor.js";
import type { MonitorTelegramOpts } from "./monitor.types.js";
import { resetTelegramPollingLeasesForTest } from "./runtime.test-support.js";

type SessionOptions = ConstructorParameters<
  typeof import("./polling-session.js").TelegramPollingSession
>[0];

const mocks = vi.hoisted(() => ({
  sessions: [] as SessionOptions[],
  runSession: vi.fn<(options: SessionOptions) => Promise<void>>(),
  config: vi.fn<() => OpenClawConfig>(() => ({ channels: { telegram: {} } })),
  readOffset: vi.fn(async () => 41 as number | null),
  writeOffset: vi.fn(async (_params: unknown) => {}),
  deleteOffset: vi.fn(async () => {}),
  startWebhook: vi.fn(async (_params: unknown) => ({ stop: vi.fn(async () => {}) })),
  closeTransport: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: mocks.config,
}));
vi.mock("./polling-session.js", () => ({
  TelegramPollingSession: class {
    constructor(private readonly options: SessionOptions) {
      mocks.sessions.push(options);
    }
    runUntilAbort() {
      return mocks.runSession(this.options);
    }
  },
}));
vi.mock("./update-offset-store.js", () => ({
  readTelegramUpdateOffset: mocks.readOffset,
  writeTelegramUpdateOffset: mocks.writeOffset,
  deleteTelegramUpdateOffset: mocks.deleteOffset,
}));
vi.mock("./webhook.js", () => ({ startTelegramWebhook: mocks.startWebhook }));
vi.mock("./fetch.js", () => ({
  resolveTelegramTransport: () => ({
    fetch: globalThis.fetch,
    sourceFetch: globalThis.fetch,
    close: mocks.closeTransport,
  }),
}));

const controllers: AbortController[] = [];
const monitors: Promise<void>[] = [];
function startMonitor(options: MonitorTelegramOpts = {}) {
  const abort = new AbortController();
  controllers.push(abort);
  const task = monitorTelegramProvider({
    token: "test-token",
    ...options,
    abortSignal: abort.signal,
  });
  monitors.push(task);
  return { abort, task };
}
function keepSessionRunning(options: SessionOptions) {
  const signal = options.abortSignal;
  if (!signal) {
    throw new Error("Expected the monitor's account abort signal");
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("monitorTelegramProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.length = 0;
    mocks.runSession.mockReset().mockResolvedValue(undefined);
    mocks.readOffset.mockReset().mockResolvedValue(41);
    mocks.config.mockReturnValue({ channels: { telegram: {} } });
    resetTelegramPollingLeasesForTest();
  });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) {
      controller.abort();
    }
    await Promise.allSettled(monitors.splice(0));
    resetTelegramPollingLeasesForTest();
  });

  it("refuses a second live monitor for the same token", async () => {
    const started = createDeferred<void>();
    mocks.runSession.mockImplementation((options) => {
      started.resolve();
      return keepSessionRunning(options);
    });
    const first = startMonitor();
    await started.promise;
    await expect(startMonitor().task).rejects.toThrow("refusing duplicate poller");
    expect(mocks.sessions).toHaveLength(1);
    first.abort.abort();
    await first.task;
  });

  it("allows separate tokens and releases the first token after shutdown", async () => {
    const started = createDeferred<void>();
    mocks.runSession.mockImplementation((options) => {
      if (mocks.sessions.length === 2) {
        started.resolve();
      }
      return keepSessionRunning(options);
    });
    const first = startMonitor({ token: "test-token-a" });
    const second = startMonitor({ token: "test-token-b" });
    await started.promise;
    first.abort.abort();
    await first.task;
    mocks.runSession.mockResolvedValueOnce(undefined);
    await startMonitor({ token: "test-token-a" }).task;
    expect(mocks.sessions).toHaveLength(3);
    second.abort.abort();
    await second.task;
  });

  it("releases token custody when the polling session fails", async () => {
    mocks.runSession.mockRejectedValueOnce(new Error("polling failed"));
    await expect(startMonitor().task).rejects.toThrow("polling failed");
    await startMonitor().task;
    expect(mocks.sessions).toHaveLength(2);
  });
});
