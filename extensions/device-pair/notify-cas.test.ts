import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createTestPluginServiceScheduler,
  createTestPluginApi,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifySubscriberStoreKey, type NotifySubscription } from "./notify-state.js";

// mock-isolation: Supply deterministic requests without reading real device-pair state.
vi.mock("openclaw/plugin-sdk/device-bootstrap", () => ({
  listDevicePairing: async () => ({
    pending: [{ requestId: "request-1", deviceId: "device-1", ts: 2_000 }],
  }),
}));

import { startPairingNotifier } from "./notify.js";
type SubscriberStore = PluginStateKeyedStore<NotifySubscription>;

describe("device-pair notify CAS", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function createHarness(delivered: NotifySubscription) {
    let current: NotifySubscription | undefined = delivered;
    let revision = 0;
    const snapshot = () => ({ value: current, comparison: String(revision) });
    const replace = (value: NotifySubscription | undefined) => {
      current = value;
      revision++;
    };
    const sendText = vi.fn(async () => ({ channel: "telegram", to: delivered.to }));
    const loadAdapter = vi.fn(async () => ({ sendText }));
    const observe = vi.fn(async () => snapshot());
    const compareAndApply = vi.fn<NonNullable<SubscriberStore["compareAndApply"]>>(
      async (_key, comparison, intent) => {
        if (comparison !== String(revision)) {
          return { status: "conflict", current: snapshot() };
        }
        if (intent.operation === "delete" && intent.action === "delete" && current) {
          replace(undefined);
          return { status: "applied" };
        }
        return { status: "unchanged" };
      },
    );
    const subscriberStore: Pick<SubscriberStore, "observe" | "compareAndApply" | "entries"> = {
      observe,
      compareAndApply,
      entries: vi.fn(async () => [
        { key: notifySubscriberStoreKey(delivered), value: delivered, createdAt: 1_000 },
      ]),
    };
    const recordSeen = vi.fn(async () => {});
    const warn = vi.fn();
    const api = createTestPluginApi({
      logger: { info() {}, warn, error() {} },
      runtime: {
        state: {
          openKeyedStore: () => ({ entries: async () => [], register: recordSeen }),
          openKeyedStoreV2: () => subscriberStore,
        },
        channel: { outbound: { loadAdapter } },
      } as never,
    });
    return {
      observe,
      compareAndApply,
      sendText,
      loadAdapter,
      calls: () =>
        [sendText, observe, compareAndApply, recordSeen].map((mock) => mock.mock.calls.length),
      warn,
      snapshot,
      replace,
      async poll() {
        const scheduler = createTestPluginServiceScheduler();
        try {
          startPairingNotifier(api, scheduler);
          await vi.advanceTimersByTimeAsync(10_000);
        } finally {
          await scheduler.stop();
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

  type Case = [
    string,
    "delivery" | "adapter" | "sendText" | "observe" | "compareAndApply",
    NotifySubscription | undefined,
    [sent: number, observed: number, compared: number, recorded: number],
  ];
  it.each<Case>([
    ["changed metadata", "delivery", delivered, [1, 1, 1, 1]],
    ["new arm", "delivery", { ...delivered, armId: "arm-2" }, [1, 1, 1, 1]],
    ["removed arm", "delivery", undefined, [1, 1, 1, 1]],
    ["disabled", "adapter", undefined, [0, 1, 0, 0]],
    ["later arm", "adapter", { ...delivered, addedAtMs: 3_000 }, [0, 1, 0, 0]],
    [
      "current thread",
      "adapter",
      { ...delivered, mode: "persistent", addedAtMs: 3_000, messageThreadId: "0271" },
      [1, 1, 0, 1],
    ],
    ["failed send", "sendText", delivered, [1, 1, 0, 0]],
    ["failed observation", "observe", delivered, [0, 1, 0, 0]],
    ["failed settlement", "compareAndApply", delivered, [1, 1, 1, 0]],
  ])("preserves state and delivery: %s", async (_label, stage, current, calls) => {
    const h = createHarness(
      stage === "adapter" ? { ...delivered, messageThreadId: 271 } : delivered,
    );
    if (stage === "delivery") {
      h.sendText.mockImplementationOnce(async () => {
        h.replace(current);
        return { channel: "telegram", to: delivered.to };
      });
    } else if (stage === "adapter") {
      h.loadAdapter.mockImplementationOnce(async () => {
        h.replace(current);
        return { sendText: h.sendText };
      });
    } else {
      h[stage].mockRejectedValueOnce(new Error("outcome unavailable"));
    }
    await h.poll();
    expect(h.calls()).toEqual(calls);
    expect(h.snapshot().value).toEqual(current);
    if (stage === "delivery") {
      expect(h.observe.mock.invocationCallOrder[0]).toBeLessThan(
        h.sendText.mock.invocationCallOrder[0]!,
      );
    } else if (stage === "adapter" && calls[0]) {
      expect(h.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ to: current?.to, threadId: "0271" }),
      );
    } else if (stage !== "adapter") {
      expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("outcome unavailable"));
    }
  });
});
