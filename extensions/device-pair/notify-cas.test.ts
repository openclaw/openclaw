import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  notifySubscriberStoreKey,
  type NotifySubscription,
} from "./notify-state.js";

vi.mock("openclaw/plugin-sdk/device-bootstrap", () => ({
  listDevicePairing: async () => ({
    pending: [{ requestId: "request-1", deviceId: "device-1", ts: 2_000 }],
    paired: [],
  }),
}));

import { createPairingNotifierService } from "./notify.js";

describe("device-pair notify CAS", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createHarness(delivered: NotifySubscription) {
    const settled = createDeferred<void>();
    let pollStarted = false;
    let current: NotifySubscription | undefined = delivered;
    let revision = 0;
    const snapshot = () => ({ value: current, comparison: String(revision) });
    const replace = (value: NotifySubscription | undefined) => {
      current = value;
      revision++;
    };
    const sendText = vi.fn(async () => ({ channel: "telegram", to: delivered.to }));
    const observe = vi.fn(async () => snapshot());
    const compareAndApply = vi.fn<
      NonNullable<PluginStateKeyedStore<NotifySubscription>["compareAndApply"]>
    >(async (_key, comparison, intent) => {
      if (comparison !== String(revision)) {
        return { status: "conflict", current: snapshot() };
      }
      if (intent.operation === "delete" && intent.action === "delete" && current) {
        replace(undefined);
        return { status: "applied" };
      }
      return { status: "unchanged" };
    });
    const subscriberStore: PluginStateKeyedStore<NotifySubscription> = {
      observe,
      compareAndApply,
      register: vi.fn(async () => {}),
      registerIfAbsent: vi.fn(async () => false),
      lookup: vi.fn(async () => current),
      consume: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
      deleteIf: vi.fn(async () => false),
      entries: vi.fn(async () => [
        { key: notifySubscriberStoreKey(delivered), value: delivered, createdAt: 1_000 },
      ]),
      clear: vi.fn(async () => {}),
    };
    const recordSeen = vi.fn(async () => settled.resolve());
    const warn = vi.fn(() => settled.resolve());
    const api = createTestPluginApi({
      logger: { info() {}, warn, error() {} },
      runtime: {
        state: {
          openKeyedStore: ({ namespace }: { namespace: string }) => {
            pollStarted = true;
            return namespace === DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE
              ? subscriberStore
              : { entries: async () => [], register: recordSeen };
          },
        },
        channel: { outbound: { loadAdapter: async () => ({ sendText }) } },
      } as never,
    });
    return {
      subscriberStore,
      observe,
      compareAndApply,
      sendText,
      recordSeen,
      warn,
      snapshot,
      replace,
      async poll() {
        const service = createPairingNotifierService(api);
        try {
          await service.start({} as never);
          await vi.advanceTimersByTimeAsync(10_000);
          await settled.promise;
        } finally {
          await service.stop?.({} as never);
          if (pollStarted) {
            await settled.promise;
            await vi.advanceTimersByTimeAsync(0);
          }
        }
      },
    };
  }

  const delivered: NotifySubscription = {
    to: "chat-123",
    mode: "once",
    addedAtMs: 1_000,
    armId: "arm-1",
  };

  it.each(["observe", "compareAndApply"] as const)(
    "rejects missing %s before delivery",
    async (capability) => {
      const harness = createHarness(delivered);
      delete harness.subscriberStore[capability];

      await harness.poll();

      expect(harness.sendText).not.toHaveBeenCalled();
      expect(harness.snapshot().value).toEqual(delivered);
      expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining("compare-and-apply"));
    },
  );

  it("retires the delivered arm without the legacy callback", async () => {
    const harness = createHarness(delivered);
    delete harness.subscriberStore.deleteIf;

    await harness.poll();

    expect(harness.snapshot().value).toBeUndefined();
    expect(harness.sendText).toHaveBeenCalledTimes(1);
    expect(harness.observe.mock.invocationCallOrder[0]).toBeGreaterThan(
      harness.sendText.mock.invocationCallOrder[0]!,
    );
    expect(harness.recordSeen).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "same arm", current: delivered, action: "delete" },
    { label: "new arm", current: { ...delivered, armId: "arm-2" }, action: "keep" },
    { label: "removed arm", current: undefined, action: "keep" },
  ])("reconsiders a conflict for $label without sending again", async ({ current, action }) => {
    const harness = createHarness(delivered);
    harness.observe.mockImplementationOnce(async () => {
      const original = harness.snapshot();
      harness.replace(current);
      return original;
    });

    await harness.poll();

    expect(harness.sendText).toHaveBeenCalledTimes(1);
    expect(harness.observe).toHaveBeenCalledTimes(1);
    expect(harness.compareAndApply).toHaveBeenCalledTimes(2);
    expect(harness.snapshot().value).toEqual(action === "delete" ? undefined : current);
    expect(harness.recordSeen).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "normalized thread", change: { messageThreadId: "0271" }, action: "delete" },
    { label: "new arm", change: { armId: "new-arm" }, action: "keep" },
    { label: "new mode", change: { mode: "persistent" as const }, action: "keep" },
    { label: "new time", change: { addedAtMs: 1_001 }, action: "keep" },
    { label: "new target", change: { to: "other-chat" }, action: "keep" },
  ])("preserves legacy generation matching for $label", async ({ change, action }) => {
    const legacy: NotifySubscription = {
      to: "chat-123",
      accountId: "telegram-default",
      messageThreadId: 271,
      mode: "once",
      addedAtMs: 1_000,
    };
    const harness = createHarness(legacy);
    const current = { ...legacy, ...change };
    harness.replace(current);

    await harness.poll();

    expect(harness.snapshot().value).toEqual(action === "delete" ? undefined : current);
    expect(harness.sendText).toHaveBeenCalledTimes(1);
  });

  it.each(["observe", "compareAndApply"] as const)(
    "does not retry a rejected %s or replay delivery",
    async (operation) => {
      const harness = createHarness(delivered);
      harness[operation].mockRejectedValueOnce(new Error("outcome unavailable"));

      await harness.poll();

      expect(harness.sendText).toHaveBeenCalledTimes(1);
      expect(harness.observe).toHaveBeenCalledTimes(1);
      expect(harness.compareAndApply).toHaveBeenCalledTimes(operation === "observe" ? 0 : 1);
      expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining("outcome unavailable"));
      expect(harness.recordSeen).not.toHaveBeenCalled();
      expect(harness.snapshot().value).toEqual(delivered);
    },
  );
});
