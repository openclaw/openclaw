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
import { resetTelegramPollingLeasesForTest } from "./runtime.test-support.js";
import type * as OffsetStore from "./update-offset-store.js";

type SessionOptions = ConstructorParameters<typeof TelegramPollingSession>[0];

const mocks = vi.hoisted(() => ({
  sessions: [] as SessionOptions[],
  runSession: vi.fn<(options: SessionOptions) => Promise<void>>(),
  config: vi.fn<() => OpenClawConfig>(() => ({ channels: { telegram: {} } })),
  prepareAccount: vi.fn<typeof OffsetStore.prepareTelegramAccount>(),
  writeOffset: vi.fn(async (_params: unknown) => {}),
  startWebhook: vi.fn(async (_params: unknown) => ({ stop: vi.fn(async () => {}) })),
  closeTransport: vi.fn(async () => {}),
  runtime: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: mocks.config,
}));
vi.mock("./runtime.js", () => ({ getTelegramRuntime: mocks.runtime }));
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
  prepareTelegramAccount: mocks.prepareAccount,
  writeTelegramUpdateOffset: mocks.writeOffset,
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
    mocks.prepareAccount.mockReset().mockResolvedValue(41);
    mocks.config.mockReturnValue({ channels: { telegram: {} } });
    mocks.runtime.mockReset();
    resetTelegramPollingLeasesForTest();
  });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) {
      controller.abort();
    }
    await Promise.allSettled(monitors.splice(0));
    resetTelegramPollingLeasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("retries an interrupted identity reset before polling and preserves same-bot pending work", async () => {
    const offsets = new Map<string, unknown>();
    let interruptReset = false;
    await withStateDirEnv("telegram-rotation-", async ({ stateDir }) => {
      const store = await vi.importActual<typeof OffsetStore>("./update-offset-store.js");
      const queue = createChannelIngressQueueForTests({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      mocks.runtime.mockReturnValue({
        state: {
          openChannelIngressQueue: () => queue,
          openKeyedStore: () => ({
            lookup: async (key: string) => offsets.get(key),
            register: async (key: string, value: unknown) => {
              if (interruptReset) {
                interruptReset = false;
                throw new Error("interrupted reset");
              }
              offsets.set(key, value);
            },
          }),
        },
      });
      mocks.prepareAccount.mockImplementation(store.prepareTelegramAccount);
      await queue.enqueue("1", { text: "bot A" });
      await queue.complete("1");
      await store.writeTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:token-a",
        updateId: 1,
      });
      const purge = queue.purge?.bind(queue);
      queue.purge = undefined;
      // Simulate interruption between the purge and identity replacement commits.
      interruptReset = true;
      await expect(startMonitor({ token: "222222:token-b" }).task).rejects.toThrow(
        /account "default".*restart.*host/,
      );
      expect(await store.readTelegramUpdateOffset({ botToken: "111111:token-a" })).toBe(1);
      expect(await queue.enqueue("1", { text: "unsupported reset" })).toMatchObject({
        kind: "completed",
      });
      queue.purge = purge;
      await expect(startMonitor({ token: "222222:token-b" }).task).rejects.toThrow(
        /account "default".*restart.*interrupted reset/,
      );
      expect(mocks.sessions).toHaveLength(0);
      expect(await store.readTelegramUpdateOffset({ botToken: "111111:token-a" })).toBe(1);
      expect(await queue.enqueue("1", { text: "bot B" })).toMatchObject({ kind: "accepted" });

      await startMonitor({ token: "222222:token-b" }).task;
      expect(await queue.listPending()).toEqual([]);
      expect(mocks.sessions[0]?.getCommittedUpdateId()).toBeNull();
      await queue.enqueue("1", { text: "bot B pending" });
      await store.writeTelegramUpdateOffset({ botToken: "222222:token-b", updateId: 1 });
      await startMonitor({ token: "222222:token-b" }).task;
      expect(await queue.listPending()).toMatchObject([
        { id: "1", payload: { text: "bot B pending" } },
      ]);
      expect(mocks.sessions[1]?.getCommittedUpdateId()).toBe(1);
    });
  });

  it.each(["lookup", "purge"])(
    "preserves replacement rows and the offset when aborted during %s",
    async (phase) => {
      await withStateDirEnv("telegram-aborted-reset-", async ({ stateDir }) => {
        const store = await vi.importActual<typeof OffsetStore>("./update-offset-store.js");
        const paused = createDeferred<void>();
        const resume = createDeferred<void>();
        let storedOffset: unknown = {
          version: 3,
          botId: "111111",
          tokenFingerprint: "old",
          lastUpdateId: 1,
        };
        const queue = createChannelIngressQueueForTests({
          channelId: "telegram",
          accountId: "default",
          stateDir,
        });
        if (phase === "purge") {
          const purge = queue.purge?.bind(queue);
          if (!purge) {
            throw new Error("Expected core purge capability");
          }
          queue.purge = async () => {
            const count = await purge();
            paused.resolve();
            await resume.promise;
            return count;
          };
        }
        mocks.runtime.mockReturnValue({
          state: {
            openChannelIngressQueue: () => queue,
            openKeyedStore: () => ({
              lookup: async () => {
                if (phase === "lookup") {
                  paused.resolve();
                  await resume.promise;
                }
                return storedOffset;
              },
              register: async (_key: string, value: unknown) => {
                storedOffset = value;
              },
            }),
          },
        });
        mocks.prepareAccount.mockImplementation(store.prepareTelegramAccount);
        const monitor = startMonitor({ token: "222222:token-b" });
        try {
          await paused.promise;
          monitor.abort.abort(new Error("account task retired"));
          await queue.enqueue("pending", { text: "replacement pending" });
          await queue.enqueue("claimed", { text: "replacement claimed" });
          await queue.claim("claimed");
          const pending = await queue.listPending();
          const claims = await queue.listClaims();
          const rejected = expect(monitor.task).rejects.toThrow("account task retired");
          resume.resolve();
          await rejected;
          expect(await queue.listPending()).toEqual(pending);
          expect(await queue.listClaims()).toEqual(claims);
          expect(await store.readTelegramUpdateOffset({})).toBe(1);
          expect(mocks.sessions).toHaveLength(0);
        } finally {
          resume.resolve();
          await Promise.allSettled([monitor.task]);
        }
      });
    },
  );

  it.each([
    { name: "same-bot token rotation", version: 3, botId: "111111", tokenFingerprint: "old" },
    { name: "matching legacy identity", version: 2, botId: "111111", tokenFingerprint: null },
    { name: "unknown legacy identity", version: 1, botId: null, tokenFingerprint: null },
  ])("keeps queue rows for $name", async (identity) => {
    await withStateDirEnv("telegram-same-bot-", async ({ stateDir }) => {
      const store = await vi.importActual<typeof OffsetStore>("./update-offset-store.js");
      let storedOffset: unknown = { ...identity, lastUpdateId: 2 };
      const queue = createChannelIngressQueueForTests({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      mocks.runtime.mockReturnValue({
        state: {
          openChannelIngressQueue: () => queue,
          openKeyedStore: () => ({
            lookup: async () => storedOffset,
            register: async (_key: string, value: unknown) => {
              storedOffset = value;
            },
          }),
        },
      });
      mocks.prepareAccount.mockImplementation(store.prepareTelegramAccount);
      await queue.enqueue("1", { text: "pending" });
      await queue.enqueue("2", { text: "delivered" });
      await queue.complete("2");

      await startMonitor({ token: "111111:token-b" }).task;

      expect(await queue.listPending()).toMatchObject([{ id: "1", payload: { text: "pending" } }]);
      expect(await queue.enqueue("2", { text: "duplicate" })).toMatchObject({ kind: "completed" });
      expect(storedOffset).toMatchObject({ botId: "111111", lastUpdateId: null });
      expect(mocks.sessions[0]?.getCommittedUpdateId()).toBeNull();
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
