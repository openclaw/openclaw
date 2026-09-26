import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorTelegramProvider } from "./monitor.js";
import type { MonitorTelegramOpts } from "./monitor.types.js";
import type { TelegramPollingSession } from "./polling-session.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramPollingLeasesForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import type * as OffsetStore from "./update-offset-store.js";

type SessionOptions = ConstructorParameters<typeof TelegramPollingSession>[0];

const mocks = vi.hoisted(() => ({
  sessions: [] as SessionOptions[],
  runSession: vi.fn<(options: SessionOptions) => Promise<void>>(),
  config: vi.fn<() => OpenClawConfig>(() => ({ channels: { telegram: {} } })),
  readOffset: vi.fn<typeof OffsetStore.readTelegramUpdateOffset>(),
  writeOffset: vi.fn(async (_params: unknown) => {}),
  deleteOffset: vi.fn<typeof OffsetStore.deleteTelegramUpdateOffset>(),
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
    mocks.deleteOffset.mockReset().mockResolvedValue(undefined);
    resetTelegramPollingLeasesForTest();
  });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) {
      controller.abort();
    }
    await Promise.allSettled(monitors.splice(0));
    resetTelegramPollingLeasesForTest();
    clearTelegramRuntimeForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("retries an interrupted identity reset before polling and preserves same-bot pending work", async () => {
    const offsets = new Map<string, unknown>();
    await withStateDirEnv("telegram-rotation-", async ({ stateDir }) => {
      const store = await vi.importActual<typeof OffsetStore>("./update-offset-store.js");
      const queue = createChannelIngressQueueForTests({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      setTelegramRuntime({
        state: {
          openChannelIngressQueue: () => queue,
          openKeyedStore: () => ({
            lookup: async (key: string) => offsets.get(key),
            register: async (key: string, value: unknown) => {
              offsets.set(key, value);
            },
            delete: async (key: string) => offsets.delete(key),
          }),
        },
      } as TelegramRuntime);
      mocks.readOffset.mockImplementation(store.readTelegramUpdateOffset);
      mocks.deleteOffset
        .mockImplementationOnce(async () => {
          // Simulate interruption between the two independent store commits.
          throw new Error("interrupted reset");
        })
        .mockImplementation(store.deleteTelegramUpdateOffset);
      await queue.enqueue("1", { text: "bot A" });
      await queue.complete("1");
      await store.writeTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:token-a",
        updateId: 1,
      });
      await expect(startMonitor({ token: "222222:token-b" }).task).rejects.toThrow(
        "interrupted reset",
      );
      expect(mocks.sessions).toHaveLength(0);
      expect(await store.readTelegramUpdateOffset({ botToken: "111111:token-a" })).toBe(1);
      expect(await queue.enqueue("1", { text: "bot B" })).toMatchObject({ kind: "accepted" });

      await startMonitor({ token: "222222:token-b" }).task;
      expect(await queue.listPending()).toEqual([]);
      expect(mocks.sessions[0].getCommittedUpdateId()).toBeNull();
      await queue.enqueue("1", { text: "bot B pending" });
      await store.writeTelegramUpdateOffset({ botToken: "222222:token-b", updateId: 1 });
      await startMonitor({ token: "222222:token-b" }).task;
      expect(await queue.listPending()).toMatchObject([
        { id: "1", payload: { text: "bot B pending" } },
      ]);
      expect(mocks.sessions[1].getCommittedUpdateId()).toBe(1);
    });
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
