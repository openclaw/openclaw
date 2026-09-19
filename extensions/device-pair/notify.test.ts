// Device Pair tests cover notify plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { listDevicePairing as listDevicePairingFn } from "openclaw/plugin-sdk/device-bootstrap";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  notifyRequestStoreKey,
  notifySubscriberStoreKey,
  type NotifySubscription,
} from "./notify-state.js";

const listDevicePairingMock = vi.hoisted(() =>
  vi.fn<typeof listDevicePairingFn>(async () => ({ pending: [], paired: [] })),
);

vi.mock("openclaw/plugin-sdk/device-bootstrap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/device-bootstrap")>()),
  listDevicePairing: listDevicePairingMock,
}));

import { createPairingNotifierService, handleNotifyCommand } from "./notify.js";

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/device-bootstrap");
  vi.resetModules();
});

describe("device-pair notify persistence", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [], paired: [] });
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-pair-notify-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function openStore<T>(options: OpenKeyedStoreOptions) {
    return createPluginStateKeyedStoreForTests<T>("device-pair", {
      ...options,
      env: options.env ?? env,
    });
  }

  function createApi(
    sendText?: ReturnType<typeof vi.fn>,
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T> = openStore,
  ) {
    return createTestPluginApi({
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
          openKeyedStore,
        },
        channel: {
          outbound: {
            loadAdapter: vi.fn(async () => (sendText ? { sendText } : undefined)),
          },
        },
      } as never,
    });
  }

  function openSubscriberStore() {
    return openStore<NotifySubscription>({
      namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
      maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
    });
  }

  function observeNotifyStorage() {
    const reads: Promise<unknown>[] = [];
    const active = new Set<Promise<unknown>>();
    const failed = createDeferred<unknown>();
    const waitFor = async <T>(operation: Promise<T>): Promise<T> => {
      const outcome = await Promise.race([
        operation.then((value) => ({ ok: true as const, value })),
        failed.promise.then((error) => ({ ok: false as const, error })),
      ]);
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.value;
    };
    const track = <T>(operation: Promise<T>): Promise<T> => {
      active.add(operation);
      void operation.then(
        () => active.delete(operation),
        (error: unknown) => {
          active.delete(operation);
          failed.resolve(error);
        },
      );
      return operation;
    };
    const stored = new Map<string, ReturnType<typeof createDeferred<void>>>();
    const storedReceipt = (key: string) => {
      let receipt = stored.get(key);
      if (!receipt) {
        receipt = createDeferred<void>();
        stored.set(key, receipt);
      }
      return receipt;
    };
    const openKeyedStore = <T>(options: OpenKeyedStoreOptions) => {
      const store = openStore<T>(options);
      const entries = store.entries.bind(store);
      store.entries = () => {
        const reading = track(entries());
        reads.push(reading);
        return reading;
      };
      const observe = store.observe;
      store.observe = (key) => track(observe(key));
      const compareAndApply = store.compareAndApply;
      store.compareAndApply = (key, comparison, intent) =>
        track(compareAndApply(key, comparison, intent));
      if (options.namespace === DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE) {
        const register = store.register.bind(store);
        store.register = async (key, value, opts) => {
          await track(register(key, value, opts));
          storedReceipt(key).resolve();
        };
      }
      return store;
    };
    return {
      openKeyedStore,
      takeStoreReads: () => reads.splice(0),
      waitFor,
      requestStored: (requestId: string) =>
        waitFor(storedReceipt(notifyRequestStoreKey(requestId)).promise),
      pollFailed: (message: string) => failed.resolve(new Error(message)),
      async settlePoll(requestId: string) {
        const terminal =
          listDevicePairingMock.mock.calls.length > 0
            ? waitFor(storedReceipt(notifyRequestStoreKey(requestId)).promise)
            : Promise.resolve();
        const results = await Promise.allSettled([terminal, ...active]);
        await vi.advanceTimersByTimeAsync(0);
        for (const result of results) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      },
    };
  }

  it.each([true, false])(
    "reports live subscriber counts with count support=%s",
    async (supportsCount) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const subscriber: NotifySubscription = {
        to: "chat-123",
        mode: "persistent",
        addedAtMs: 1,
      };
      const subscriberStore = openSubscriberStore();
      await subscriberStore.register(notifySubscriberStoreKey(subscriber), subscriber);
      await subscriberStore.register("expired", subscriber, { ttlMs: 1 });
      await openStore({ namespace: "other", maxEntries: 10 }).register("sibling", subscriber);
      vi.setSystemTime(1_001);
      const api = createApi(undefined, <T>(options: OpenKeyedStoreOptions) => {
        const store = openStore<T>(options);
        if (supportsCount) {
          return store;
        }
        const { count: _count, ...olderStore } = store;
        return olderStore;
      });
      for (const [senderId, mode] of [
        ["chat-123", "persistent"],
        ["missing", "off"],
      ]) {
        const status = await handleNotifyCommand({
          api,
          ctx: { channel: "telegram", senderId },
          action: "status",
        });
        expect(status.text).toContain(`Mode: ${mode}`);
        expect(status.text).toContain("Subscribers: 1");
        expect(status.text).toContain("Pending requests: 0");
      }
    },
  );

  it("counts unrelated corrupt subscriber rows but still validates the selected chat", async () => {
    const subscriber: NotifySubscription = { to: "chat-123", mode: "once", addedAtMs: 1 };
    const subscriberStore = openSubscriberStore();
    await subscriberStore.register(notifySubscriberStoreKey(subscriber), subscriber);
    await subscriberStore.register("unrelated", subscriber);
    const { db } = openOpenClawStateDatabase({ env });
    const corrupt = db.prepare(
      "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
    );
    corrupt.run("{", "device-pair", DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE, "unrelated");
    const command = {
      api: createApi(),
      ctx: { channel: "telegram", senderId: "chat-123" },
      action: "status",
    };
    const status = await handleNotifyCommand(command);
    expect(status.text).toContain("Mode: once");
    expect(status.text).toContain("Subscribers: 2");
    const olderApi = createApi(undefined, <T>(options: OpenKeyedStoreOptions) => {
      const { count: _count, ...store } = openStore<T>(options);
      return store;
    });
    await expect(handleNotifyCommand({ ...command, api: olderApi })).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
      operation: "entries",
    });
    corrupt.run(
      "{",
      "device-pair",
      DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
      notifySubscriberStoreKey(subscriber),
    );
    await expect(handleNotifyCommand(command)).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
      operation: "lookup",
    });
  });

  it("propagates count failures without retrying enumeration", async () => {
    const failure = new Error("count unavailable");
    const entries = vi.fn(async () => []);
    const api = createApi(undefined, <T>(options: OpenKeyedStoreOptions) => ({
      ...openStore<T>(options),
      count: async () => {
        throw failure;
      },
      entries,
    }));
    await expect(
      handleNotifyCommand({
        api,
        ctx: { channel: "telegram", senderId: "chat-123" },
        action: "status",
      }),
    ).rejects.toBe(failure);
    expect(entries).not.toHaveBeenCalled();
  });

  it("defers the first notify poll and keeps one in flight across service recreation", async () => {
    vi.useFakeTimers();
    const firstPoll = createDeferred<Awaited<ReturnType<typeof listDevicePairingMock>>>();
    const failedPoll = createDeferred<Awaited<ReturnType<typeof listDevicePairingMock>>>();
    listDevicePairingMock
      .mockImplementationOnce(() => firstPoll.promise)
      .mockImplementationOnce(() => failedPoll.promise)
      .mockResolvedValue({ pending: [], paired: [] });
    const storage = observeNotifyStorage();
    const api = createApi(undefined, storage.openKeyedStore);
    let service = createPairingNotifierService(api);

    await service.start({} as never);
    expect(listDevicePairingMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(1);

    await service.stop?.({} as never);
    service = createPairingNotifierService(createApi(undefined, storage.openKeyedStore));
    await service.start({} as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(1);

    await Promise.all(storage.takeStoreReads());
    firstPoll.resolve({ pending: [], paired: [] });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(2);

    await Promise.all(storage.takeStoreReads());
    failedPoll.reject(new Error("poll failed"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(3);
    await Promise.all(storage.takeStoreReads());

    await service.stop?.({} as never);
  });

  it("delivers each request once when a service reload interrupts a slow send", async () => {
    vi.useFakeTimers();
    const firstSend = createDeferred<unknown>();
    const sendEntered = createDeferred<void>();
    const storage = observeNotifyStorage();
    const sendText = vi
      .fn()
      .mockImplementationOnce(() => {
        sendEntered.resolve();
        return firstSend.promise;
      })
      .mockResolvedValue({ channel: "telegram", to: "chat-123" });
    const firstRequest = {
      requestId: "request-1",
      deviceId: "device-1",
      publicKey: "public-key-1",
      displayName: "First device",
      ts: 1,
    };
    const secondRequest = {
      requestId: "request-2",
      deviceId: "device-2",
      publicKey: "public-key-2",
      displayName: "Second device",
      ts: 2,
    };
    const api = createApi(sendText, storage.openKeyedStore);
    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
      },
      action: "on",
    });
    listDevicePairingMock.mockResolvedValue({ pending: [firstRequest], paired: [] });
    let service = createPairingNotifierService(api);

    await service.start({} as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await sendEntered.promise;
    expect(sendText).toHaveBeenCalledTimes(1);

    await service.stop?.({} as never);
    service = createPairingNotifierService(createApi(sendText, storage.openKeyedStore));
    await service.start({} as never);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendText).toHaveBeenCalledTimes(1);

    firstSend.resolve({ channel: "telegram", to: "chat-123" });
    await storage.requestStored("request-1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendText).toHaveBeenCalledTimes(1);

    await Promise.all(storage.takeStoreReads());
    listDevicePairingMock.mockResolvedValue({
      pending: [firstRequest, secondRequest],
      paired: [],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await storage.requestStored("request-2");
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls[1]?.[0]).toMatchObject({
      to: "chat-123",
      text: expect.stringContaining("ID: request-2"),
    });

    await service.stop?.({} as never);
  });

  it("preserves subscriber changes made while a notification is in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const firstSend = createDeferred<unknown>();
    const sendEntered = createDeferred<void>();
    const storage = observeNotifyStorage();
    const sendText = vi.fn(() => {
      sendEntered.resolve();
      return firstSend.promise;
    });
    const api = createApi(sendText, storage.openKeyedStore);
    await handleNotifyCommand({
      api,
      ctx: { channel: "telegram", senderId: "old-chat" },
      action: "on",
    });
    listDevicePairingMock.mockResolvedValue({
      pending: [
        {
          requestId: "request-1",
          deviceId: "device-1",
          publicKey: "public-key-1",
          ts: 2_000,
        },
      ],
      paired: [],
    });
    const service = createPairingNotifierService(api);

    await service.start({} as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await sendEntered.promise;
    expect(sendText).toHaveBeenCalledTimes(1);

    await handleNotifyCommand({
      api,
      ctx: { channel: "telegram", senderId: "old-chat" },
      action: "off",
    });
    await handleNotifyCommand({
      api,
      ctx: { channel: "telegram", senderId: "new-chat" },
      action: "on",
    });
    firstSend.resolve({ channel: "telegram", to: "old-chat" });
    await storage.requestStored("request-1");
    await vi.advanceTimersByTimeAsync(0);

    await expect(openSubscriberStore().entries()).resolves.toMatchObject([
      {
        key: notifySubscriberStoreKey({ to: "new-chat" }),
        value: { to: "new-chat", mode: "persistent" },
      },
    ]);
    await service.stop?.({} as never);
  });

  it("preserves a one-shot subscription re-armed during its delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const firstSend = createDeferred<unknown>();
    const sendEntered = createDeferred<void>();
    const storage = observeNotifyStorage();
    const sendText = vi.fn(() => {
      sendEntered.resolve();
      return firstSend.promise;
    });
    const api = createApi(sendText, storage.openKeyedStore);
    api.logger.warn = storage.pollFailed;
    await handleNotifyCommand({
      api,
      ctx: { channel: "telegram", senderId: "chat-123" },
      action: "once",
    });
    listDevicePairingMock.mockResolvedValue({
      pending: [
        {
          requestId: "request-1",
          deviceId: "device-1",
          publicKey: "public-key-1",
          ts: 2_000,
        },
      ],
      paired: [],
    });
    const service = createPairingNotifierService(api);

    try {
      await service.start({} as never);
      await vi.advanceTimersByTimeAsync(10_000);
      await storage.waitFor(sendEntered.promise);
      expect(sendText).toHaveBeenCalledTimes(1);

      await handleNotifyCommand({
        api,
        ctx: { channel: "telegram", senderId: "chat-123" },
        action: "once",
      });
      firstSend.resolve({ channel: "telegram", to: "chat-123" });
      await storage.requestStored("request-1");
      await vi.advanceTimersByTimeAsync(0);

      await expect(
        openSubscriberStore().lookup(notifySubscriberStoreKey({ to: "chat-123" })),
      ).resolves.toMatchObject({
        to: "chat-123",
        mode: "once",
        addedAtMs: 11_000,
      });
    } finally {
      await service.stop?.({} as never);
      firstSend.resolve({ channel: "telegram", to: "chat-123" });
      await storage.settlePoll("request-1");
    }
  });

  it("keeps the request boundary at the current millisecond when re-armed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sendText = vi.fn(async () => ({ channel: "telegram", to: "chat-123" }));
    const storage = observeNotifyStorage();
    const api = createApi(sendText, storage.openKeyedStore);
    api.logger.warn = storage.pollFailed;
    const command = {
      api,
      ctx: { channel: "telegram", senderId: "chat-123" },
      action: "once" as const,
    };

    await handleNotifyCommand(command);
    const key = notifySubscriberStoreKey({ to: "chat-123" });
    const first = await openSubscriberStore().lookup(key);
    await handleNotifyCommand(command);
    const second = await openSubscriberStore().lookup(key);

    expect(first).toMatchObject({ addedAtMs: 1_000, armId: expect.any(String) });
    expect(second).toMatchObject({ addedAtMs: 1_000, armId: expect.any(String) });
    expect(second?.armId).not.toBe(first?.armId);

    listDevicePairingMock.mockResolvedValue({
      pending: [
        {
          requestId: "request-same-ms",
          deviceId: "device-1",
          publicKey: "public-key-1",
          ts: 1_000,
        },
      ],
      paired: [],
    });
    const service = createPairingNotifierService(api);
    try {
      await service.start({} as never);
      await vi.advanceTimersByTimeAsync(10_000);
      await storage.requestStored("request-same-ms");

      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("ID: request-same-ms") }),
      );
    } finally {
      await service.stop?.({} as never);
      await storage.settlePoll("request-same-ms");
    }
  });

  it("delivers a one-shot subscription to only the first new request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sendText = vi.fn(async () => ({ channel: "telegram", to: "chat-123" }));
    const storage = observeNotifyStorage();
    const api = createApi(sendText, storage.openKeyedStore);
    api.logger.warn = storage.pollFailed;
    await handleNotifyCommand({
      api,
      ctx: { channel: "telegram", senderId: "chat-123" },
      action: "once",
    });
    listDevicePairingMock.mockResolvedValue({
      pending: [
        {
          requestId: "request-1",
          deviceId: "device-1",
          publicKey: "public-key-1",
          ts: 1_001,
        },
        {
          requestId: "request-2",
          deviceId: "device-2",
          publicKey: "public-key-2",
          ts: 1_002,
        },
      ],
      paired: [],
    });
    const service = createPairingNotifierService(api);

    try {
      await service.start({} as never);
      await vi.advanceTimersByTimeAsync(10_000);
      await storage.requestStored("request-1");

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("ID: request-1") }),
      );
      await expect(openSubscriberStore().entries()).resolves.toStrictEqual([]);
    } finally {
      await service.stop?.({} as never);
      await storage.settlePoll("request-1");
    }
  });

  it("matches persisted telegram thread ids across number and string roundtrips", async () => {
    const subscriber: NotifySubscription = {
      to: "chat-123",
      accountId: "telegram-default",
      messageThreadId: 271,
      mode: "persistent",
      addedAtMs: 1,
    };
    await openSubscriberStore().register(notifySubscriberStoreKey(subscriber), subscriber);
    const api = createApi();

    const status = await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
        accountId: "telegram-default",
        messageThreadId: "271",
      },
      action: "status",
    });

    expect(status.text).toContain("Pair request notifications: enabled for this chat.");
    expect(status.text).toContain("Mode: persistent");

    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
        accountId: "telegram-default",
        messageThreadId: "271",
      },
      action: "off",
    });

    await expect(openSubscriberStore().entries()).resolves.toStrictEqual([]);
  });

  it("does not remove a different persisted subscriber when notify fields contain pipes", async () => {
    const firstSubscriber: NotifySubscription = {
      to: "chat|123",
      accountId: "acct",
      mode: "persistent",
      addedAtMs: 1,
    };
    const secondSubscriber: NotifySubscription = {
      to: "chat",
      accountId: "123|acct",
      mode: "persistent",
      addedAtMs: 2,
    };
    const store = openSubscriberStore();
    await store.register(notifySubscriberStoreKey(firstSubscriber), firstSubscriber);
    await store.register(notifySubscriberStoreKey(secondSubscriber), secondSubscriber);
    const api = createApi();

    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat",
        accountId: "123|acct",
      },
      action: "off",
    });

    const status = await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat",
        accountId: "123|acct",
      },
      action: "status",
    });
    expect(status.text).toContain("Pair request notifications: disabled for this chat.");

    await expect(openSubscriberStore().entries()).resolves.toMatchObject([
      {
        key: notifySubscriberStoreKey(firstSubscriber),
        value: firstSubscriber,
      },
    ]);
  });
});
