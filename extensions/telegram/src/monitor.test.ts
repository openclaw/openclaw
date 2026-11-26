import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
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

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: mocks.config,
  captureRuntimeConfigAsyncReader: () => async () => mocks.config(),
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

const monitors: ReturnType<typeof startMonitor>[] = [];
function startMonitor(options: MonitorTelegramOpts = {}): {
  abort: AbortController;
  task: Promise<void>;
} {
  const abort = new AbortController();
  const task = monitorTelegramProvider({
    token: "test-token",
    ...options,
    abortSignal: abort.signal,
  });
  const monitor = { abort, task };
  monitors.push(monitor);
  return monitor;
}
async function createOffsetState(stateDir: string) {
  const store = await vi.importActual<typeof OffsetStore>("./update-offset-store.js");
  const queue = createChannelIngressQueueForTests({
    channelId: "telegram",
    accountId: "default",
    stateDir,
  });
  const offsets = new Map<string, unknown>();
  const keyedStore = {
    lookup: vi.fn(async (key: string) => offsets.get(key)),
    register: vi.fn(async (key: string, value: unknown) => {
      offsets.set(key, value);
    }),
  };
  mocks.runtime.mockReturnValue({
    state: {
      openChannelIngressQueue: () => queue,
      openKeyedStore: () => keyedStore,
    },
  });
  mocks.prepareAccount.mockImplementation(store.prepareTelegramAccount);
  return { store, queue, offsets, keyedStore };
}
async function withOffsetStore(
  prefix: string,
  run: (state: Awaited<ReturnType<typeof createOffsetState>>) => Promise<void>,
) {
  await withStateDirEnv(prefix, async ({ stateDir }) => {
    await run(await createOffsetState(stateDir));
  });
}
async function startLiveMonitor(token = "test-token") {
  const started = createDeferred<void>();
  mocks.runSession.mockImplementationOnce((options) => {
    expect(options.abortSignal).toBeDefined();
    started.resolve();
    return waitForAbortSignal(options.abortSignal);
  });
  const monitor = startMonitor({ token });
  await started.promise;
  return monitor;
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
    for (const { abort } of monitors) {
      abort.abort();
    }
    await Promise.allSettled(monitors.splice(0).map(({ task }) => task));
    resetTelegramPollingLeasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("retries an interrupted identity reset before polling and preserves same-bot pending work", async () => {
    await withOffsetStore("telegram-rotation-", async (state) => {
      const { store, queue } = state;
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
      state.keyedStore.register.mockRejectedValueOnce(new Error("interrupted reset"));
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

  it.each(["lookup", "purge-admission", "purge"])(
    "preserves replacement rows and the offset when aborted during %s",
    async (phase) => {
      await withOffsetStore("telegram-aborted-reset-", async (state) => {
        const { store, queue } = state;
        const paused = createDeferred<void>();
        const resume = createDeferred<void>();
        const pauseAt = async (checkpoint: string) => {
          if (phase === checkpoint) {
            paused.resolve();
            await resume.promise;
          }
        };
        state.offsets.set("default", {
          version: 3,
          botId: "111111",
          tokenFingerprint: "old",
          lastUpdateId: 1,
        });
        if (phase !== "lookup") {
          const purge = queue.purge?.bind(queue);
          if (!purge) {
            throw new Error("Expected core purge capability");
          }
          queue.purge = async (options) => {
            await pauseAt("purge-admission");
            const count = await purge(options);
            await pauseAt("purge");
            return count;
          };
        }
        if (phase === "lookup") {
          state.keyedStore.lookup.mockImplementationOnce(async (key) => {
            await pauseAt("lookup");
            return state.offsets.get(key);
          });
        }
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
    ["same-bot token rotation", "111111", "old"],
    ["matching identity without token fingerprint", "111111", null],
    ["unknown identity", null, null],
  ])("keeps queue rows for %s", async (_name, botId, tokenFingerprint) => {
    await withOffsetStore("telegram-same-bot-", async (state) => {
      const { queue } = state;
      state.offsets.set("default", { version: 3, botId, tokenFingerprint, lastUpdateId: 2 });
      await queue.enqueue("1", { text: "pending" });
      await queue.enqueue("2", { text: "delivered" });
      await queue.complete("2");

      await startMonitor({ token: "111111:token-b" }).task;

      expect(await queue.listPending()).toMatchObject([{ id: "1", payload: { text: "pending" } }]);
      expect(await queue.enqueue("2", { text: "duplicate" })).toMatchObject({ kind: "completed" });
      expect(state.offsets.get("default")).toMatchObject({ botId: "111111", lastUpdateId: null });
      expect(mocks.sessions[0]?.getCommittedUpdateId()).toBeNull();
    });
  });
  it("refuses a second live monitor for the same token", async () => {
    const first = await startLiveMonitor();
    await expect(startMonitor().task).rejects.toThrow("refusing duplicate poller");
    expect(mocks.sessions).toHaveLength(1);
    first.abort.abort();
    await first.task;
  });

  it("allows separate tokens and releases the first token after shutdown", async () => {
    // Vitest cannot resolve concurrent manual-mocked imports; keep the first monitor live.
    const first = await startLiveMonitor("test-token-a");
    const second = await startLiveMonitor("test-token-b");
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
