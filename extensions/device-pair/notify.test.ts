// Device Pair tests cover notify plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  notifySubscriberStoreKey,
  type NotifySubscription,
} from "./notify-state.js";

const listDevicePairingMock = vi.hoisted(() => vi.fn(async () => ({ pending: [] })));

vi.mock("openclaw/plugin-sdk/device-bootstrap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/device-bootstrap")>()),
  listDevicePairing: listDevicePairingMock,
}));

import { createPairingNotifierService, handleNotifyCommand } from "./notify.js";

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/device-bootstrap");
  vi.resetModules();
});

function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

describe("device-pair notify persistence", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [] });
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-pair-notify-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function openStore<T>(options: OpenKeyedStoreOptions) {
    return createPluginStateKeyedStoreForTests<T>("device-pair", {
      ...options,
      env: options.env ?? env,
    });
  }

  function createApi(sendText?: ReturnType<typeof vi.fn>) {
    return createTestPluginApi({
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
          openKeyedStore: openStore,
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

  it("keeps one notify poll in flight across service recreation", async () => {
    vi.useFakeTimers();
    const firstPoll = createDeferred<Awaited<ReturnType<typeof listDevicePairingMock>>>();
    const failedPoll = createDeferred<Awaited<ReturnType<typeof listDevicePairingMock>>>();
    listDevicePairingMock
      .mockResolvedValueOnce({ pending: [] })
      .mockImplementationOnce(() => firstPoll.promise)
      .mockImplementationOnce(() => failedPoll.promise)
      .mockResolvedValue({ pending: [] });
    const api = createApi();
    let service = createPairingNotifierService(api);

    await service.start({} as never);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(2);

    await service.stop?.({} as never);
    service = createPairingNotifierService(createApi());
    await service.start({} as never);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(2);

    firstPoll.resolve({ pending: [] });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(3);

    failedPoll.reject(new Error("poll failed"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(4);

    await service.stop?.({} as never);
  });

  it("delivers each request once when a service reload interrupts a slow send", async () => {
    vi.useFakeTimers();
    const firstSend = createDeferred<unknown>();
    const sendText = vi
      .fn()
      .mockImplementationOnce(() => firstSend.promise)
      .mockResolvedValue({ channel: "telegram", to: "chat-123" });
    const firstRequest = {
      requestId: "request-1",
      deviceId: "device-1",
      displayName: "First device",
    };
    const secondRequest = {
      requestId: "request-2",
      deviceId: "device-2",
      displayName: "Second device",
    };
    const api = createApi(sendText);
    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
      },
      action: "on",
    });
    listDevicePairingMock.mockResolvedValueOnce({ pending: [] }).mockResolvedValue({
      pending: [firstRequest],
    });
    let service = createPairingNotifierService(api);

    await service.start({} as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendText).toHaveBeenCalledTimes(1);

    await service.stop?.({} as never);
    service = createPairingNotifierService(createApi(sendText));
    await service.start({} as never);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendText).toHaveBeenCalledTimes(1);

    firstSend.resolve({ channel: "telegram", to: "chat-123" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendText).toHaveBeenCalledTimes(1);

    listDevicePairingMock.mockResolvedValue({ pending: [firstRequest, secondRequest] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls[1]?.[0]).toMatchObject({
      to: "chat-123",
      text: expect.stringContaining("ID: request-2"),
    });

    await service.stop?.({} as never);
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
