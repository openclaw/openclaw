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

describe("device-pair notify CAS", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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
  ])("preserves state and delivery: %s", async (_label, stage, expected, calls) => {
    const initial = stage === "adapter" ? { ...delivered, messageThreadId: 271 } : delivered;
    let current: NotifySubscription | undefined = initial;
    let revision = 0;
    const snapshot = () => ({ value: current, comparison: String(revision) });
    const replace = (value: NotifySubscription | undefined) => {
      current = value;
      revision++;
    };
    const sendText = vi.fn(async () => ({ channel: "telegram", to: delivered.to }));
    const loadAdapter = vi.fn(async () => ({ sendText }));
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
    const recordSeen = vi.fn(async () => {});
    const warn = vi.fn();
    const api = createTestPluginApi({
      logger: { info() {}, warn, error() {} },
      runtime: {
        state: {
          openKeyedStore: () => ({ entries: async () => [], register: recordSeen }),
          openKeyedStoreV2: () => ({
            observe,
            compareAndApply,
            entries: async () => [
              { key: notifySubscriberStoreKey(initial), value: initial, createdAt: 1_000 },
            ],
          }),
        },
        channel: { outbound: { loadAdapter } },
      } as never,
    });
    if (stage === "delivery") {
      sendText.mockImplementationOnce(async () => {
        replace(expected);
        return { channel: "telegram", to: delivered.to };
      });
    } else if (stage === "adapter") {
      loadAdapter.mockImplementationOnce(async () => {
        replace(expected);
        return { sendText };
      });
    } else {
      ({ sendText, observe, compareAndApply })[stage].mockRejectedValueOnce(
        new Error("outcome unavailable"),
      );
    }
    const scheduler = createTestPluginServiceScheduler();
    try {
      startPairingNotifier(api, scheduler);
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      await scheduler.stop();
    }
    expect(
      [sendText, observe, compareAndApply, recordSeen].map((mock) => mock.mock.calls.length),
    ).toEqual(calls);
    expect(current).toEqual(expected);
    if (stage === "delivery") {
      expect(observe.mock.invocationCallOrder[0]).toBeLessThan(
        sendText.mock.invocationCallOrder[0]!,
      );
    } else if (stage === "adapter" && calls[0]) {
      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({ to: expected?.to, threadId: "0271" }),
      );
    } else if (stage !== "adapter") {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("outcome unavailable"));
    }
  });
});
