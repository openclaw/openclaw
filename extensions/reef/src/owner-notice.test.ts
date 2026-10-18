import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReefPeerIdentity } from "./friend-types.js";
import {
  createReefOwnerNoticeHandler,
  notifyOverdueReefDeliveries,
  processReefInboxEntriesInOrder,
  ReefReceiptNotifier,
} from "./owner-notice.js";
import type { InboxEntry, ReefDeliveryRejection, ReefRejectionNoticeState } from "./types.js";

type ReefRejectionNotice = Parameters<ConstructorParameters<typeof ReefReceiptNotifier>[0]>[0];

const recipient: ReefPeerIdentity = {
  ed25519PublicKey: "A".repeat(43),
  x25519PublicKey: "B".repeat(43),
  keyEpoch: 1,
};

function rejection(value: number | string, category = "guard_deny"): ReefDeliveryRejection {
  const id = typeof value === "number" ? `01JZ${String(value).padStart(22, "0")}` : value;
  return {
    peer: "alice",
    id,
    recipient,
    textHash: "a".repeat(64),
    category,
    recovery: {
      assertCurrent() {},
      loadState: async () => undefined,
      reserve: async () => ({ kind: "reserved" }),
      complete: async () => true,
    },
  };
}

async function consumeNotice(_notice: ReefRejectionNotice): Promise<void> {}

function createNoticeStore() {
  const records = new Map<
    string,
    { peer: string; phase: "reserved" | "consumed"; state: ReefRejectionNoticeState }
  >();
  const key = (value: ReefDeliveryRejection) => `${value.peer}:${value.id}`;
  const store: ConstructorParameters<typeof ReefReceiptNotifier>[1] = {
    loadState: ({ peer }) => {
      const states = [...records.values()]
        .filter((record) => record.peer === peer)
        .map(({ state }) => state);
      if (!states.length) {
        return undefined;
      }
      const resends = states.flatMap(({ lastResendAt }) =>
        lastResendAt === undefined ? [] : [lastResendAt],
      );
      return {
        lastRejectionAt: Math.max(0, ...states.map(({ lastRejectionAt }) => lastRejectionAt)),
        ...(resends.length ? { lastResendAt: Math.max(0, ...resends) } : {}),
      };
    },
    reserve: (value, state) => {
      const existing = records.get(key(value));
      if (existing) {
        return { kind: "existing", state: existing.state };
      }
      records.set(key(value), {
        peer: value.peer,
        phase: "reserved",
        state: { ...state },
      });
      return { kind: "reserved" };
    },
    complete: (value, state) => {
      const recordKey = key(value);
      const existing = records.get(recordKey);
      if (!existing) {
        throw new Error(`missing notice reservation ${value.id}`);
      }
      records.set(recordKey, { ...existing, phase: "consumed", state: { ...state } });
    },
  };
  return { records, store };
}

it.each([true, false])("wakes only for a newly queued notice (queued: %s)", async (queued) => {
  const runtime = createPluginRuntimeMock();
  if (queued) {
    vi.mocked(runtime.channel.routing.resolveAgentRoute).mockReturnValue({
      agentId: "main",
      channel: "reef",
      accountId: "default",
      sessionKey: "agent:main:reef:direct:alice",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
  }
  vi.mocked(runtime.system.enqueueSystemEvent).mockReturnValue(queued);
  const notify = createReefOwnerNoticeHandler({ runtime, cfg: {}, handle: "bob" });
  await notify({
    text: "owner notice",
    ...(queued ? { peer: "alice" } : {}),
    contextKey: queued ? "reef:owner:alice" : "reef:owner:bob",
    wakeAgent: true,
  });
  if (queued) {
    expect(runtime.system.enqueueSystemEvent).toHaveBeenCalledWith("owner notice", {
      sessionKey: "agent:main:reef:direct:alice",
      contextKey: "reef:owner:alice",
    });
    expect(runtime.system.requestHeartbeat).toHaveBeenCalledWith({
      source: "other",
      intent: "immediate",
      reason: "reef:delivery-rejected",
      agentId: "main",
      sessionKey: "agent:main:reef:direct:alice",
    });
  } else {
    expect(runtime.system.requestHeartbeat).not.toHaveBeenCalled();
  }
});

it("advances the full batch when a receipt notice fails", async () => {
  const order: string[] = [];
  const onNoticeError = vi.fn();
  const message = { id: "message", kind: "message" } as InboxEntry;
  const receipt = { id: "receipt", kind: "receipt" } as InboxEntry;
  const later = { id: "later", kind: "message" } as InboxEntry;

  await processReefInboxEntriesInOrder({
    entries: [message, receipt, later],
    processEntries: async ([entry]) => {
      order.push(`process:${entry!.id}`);
      return entry === receipt ? [rejection(entry.id)] : [];
    },
    notifyRejections: async ([deliveryRejection]) => {
      order.push(`notice:${deliveryRejection?.id ?? "none"}`);
      if (deliveryRejection?.id === receipt.id) {
        throw new Error("notice failed");
      }
    },
    onNoticeError,
  });

  expect(order).toEqual([
    "process:message",
    "notice:none",
    "process:receipt",
    "notice:receipt",
    "process:later",
    "notice:none",
  ]);
  expect(onNoticeError).toHaveBeenCalledOnce();
});

describe("ReefReceiptNotifier", () => {
  const schedulers: ReturnType<typeof createTestPluginServiceScheduler>[] = [];
  function fixture() {
    const notices = createNoticeStore();
    const notify = vi.fn(consumeNotice);
    const onError = vi.fn();
    const clock = { now: 10_000 };
    const start = (sink = notify) => {
      const scheduler = createTestPluginServiceScheduler();
      schedulers.push(scheduler);
      const notifier = new ReefReceiptNotifier(sink, notices.store, {
        scheduler,
        now: () => clock.now,
        onError,
      });
      return { notifier, scheduler };
    };
    return { notices, notify, onError, clock, start, ...start() };
  }
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    vi.useFakeTimers();
    f = fixture();
  });
  afterEach(async () => {
    await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.stop()));
    vi.useRealTimers();
  });
  function expectResends(...allowed: boolean[]) {
    expect(f.notify.mock.calls.map(([notice]) => notice.allowResend)).toEqual(allowed);
  }
  function expectStopOnly(index: number) {
    expect(f.notify.mock.calls[index]![0]).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries/),
      allowResend: false,
    });
  }
  function phase(pending: ReefDeliveryRejection) {
    return f.notices.records.get(`${pending.peer}:${pending.id}`)?.phase;
  }

  it("extends the resend cooldown from every rejection", async () => {
    const first = rejection(105);
    await f.notifier.notifyRejections([first, first]);
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0]![0]).toMatchObject({
      text: expect.stringMatching(/at most once.*stop and wait for owner guidance/i),
      peer: "alice",
      messageId: first.id,
      allowResend: true,
    });
    f.clock.now += 14 * 60_000;
    await f.notifier.notifyRejections([rejection(107)]);
    expectStopOnly(1);
    f.clock.now += 2 * 60_000;
    await f.notifier.notifyRejections([rejection(108)]);
    expect(f.notify.mock.calls[2]![0]).toMatchObject({ allowResend: false });
    f.clock.now += 15 * 60_000;
    await f.notifier.notifyRejections([rejection(109)]);
    expect(f.notify.mock.calls[3]![0]).toMatchObject({ allowResend: true });
  });

  it.each([
    { reason: "non-guard rejection", category: "deterministic_deny", textHash: "a".repeat(64) },
    { reason: "missing send-time fingerprint", category: "guard_deny", textHash: undefined },
  ])("never grants a resend for $reason", async ({ category, textHash }) => {
    await f.notifier.notifyRejections([{ ...rejection(110, category), textHash }]);
    expectStopOnly(0);
  });

  it.each([
    ["applies recovered reservations before fresh items", 11_000, false],
    ["fails closed when recovered state cannot be loaded", 1_000_000, true],
  ] as const)("%s", async (_name, now, loadFails) => {
    const recovered = rejection(111);
    const reservedNotice = { lastRejectionAt: 10_000, lastResendAt: 10_000 };
    await f.notices.store.reserve(recovered, reservedNotice);
    const loadError = new Error("state unavailable");
    if (loadFails) {
      vi.spyOn(f.notices.store, "loadState").mockImplementationOnce(() => {
        throw loadError;
      });
    }
    f.clock.now = now;
    await f.notifier.notifyRejections([rejection(112), { ...recovered, reservedNotice }]);
    if (loadFails) {
      expect(f.onError).toHaveBeenCalledWith(loadError, recovered.id);
    }
    expectResends(false, false);
  });

  it("preserves the fresh resend cooldown when recovery starts during state loading", async () => {
    const recovered = rejection(131);
    const reservedNotice = { lastRejectionAt: 10_000, lastResendAt: 10_000 };
    await f.notices.store.reserve(recovered, reservedNotice);
    const captured = await f.notices.store.loadState(rejection("cooldown"));
    const loadStarted = createDeferred<void>();
    const loadFinished = createDeferred<ReefRejectionNoticeState | undefined>();
    vi.spyOn(f.notices.store, "loadState").mockImplementationOnce(() => {
      loadStarted.resolve();
      return loadFinished.promise;
    });
    f.clock.now = 1_000_000;
    const fresh = rejection(132);
    const later = rejection(133);
    const freshNotification = f.notifier.notifyRejections([fresh]);
    await loadStarted.promise;
    const recoveredNotification = f.notifier.notifyRejections([{ ...recovered, reservedNotice }]);
    loadFinished.resolve(captured);
    await Promise.all([freshNotification, recoveredNotification]);
    f.clock.now += 1;
    await f.notifier.notifyRejections([later]);
    expect(f.notify.mock.calls.map(([notice]) => [notice.messageId, notice.allowResend])).toEqual([
      [fresh.id, true],
      [recovered.id, false],
      [later.id, false],
    ]);
  });

  it("keeps cached cooldown time monotonic after a backward clock adjustment", async () => {
    const previous = rejection(113, "deterministic_deny");
    await f.notices.store.reserve(previous, { lastRejectionAt: 1_000_000 });
    await f.notices.store.complete(previous, { lastRejectionAt: 1_000_000 });
    f.clock.now = 900_000;
    await f.notifier.notifyRejections([rejection(114)]);
    f.clock.now = 1_800_000;
    await f.notifier.notifyRejections([rejection(115)]);
    expectResends(false, false);
  });

  it.each(["loadState", "reserve"] as const)(
    "retries a fresh rejection on reconciliation after durable %s rejects",
    async (operation) => {
      const stateError = new Error("state unavailable");
      vi.spyOn(f.notices.store, operation).mockRejectedValueOnce(stateError);
      const pending = rejection(124);
      await f.notifier.notifyRejections([pending]);
      expect(f.notify).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await f.notifier.notifyRejections([pending]);
      expect(f.onError).toHaveBeenCalledWith(stateError, pending.id);
      expect(f.notify).toHaveBeenCalledOnce();
    },
  );

  it("keeps a failed dispatch reserved and retries with stop-only guidance", async () => {
    f.notify.mockRejectedValueOnce(new Error("dispatch interrupted"));
    const pending = rejection(109);
    await f.notifier.notifyRejections([pending]);
    expect(phase(pending)).toBe("reserved");
    expect(vi.getTimerCount()).toBe(0);
    await f.notifier.notifyRejections([pending]);
    expect(f.notify).toHaveBeenCalledTimes(2);
    expectStopOnly(1);
    expect(phase(pending)).toBe("consumed");
  });

  it("does not retry a notice after the account stops", async () => {
    f.notify.mockRejectedValue(new Error("dispatch unavailable"));
    const pending = rejection(126);
    await f.notifier.notifyRejections([pending]);
    await f.scheduler.stop();
    await f.notifier.notifyRejections([pending]);
    expect(f.notify).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers a crash after agent consumption without granting another resend", async () => {
    const complete = vi.spyOn(f.notices.store, "complete").mockImplementationOnce(() => {
      throw new Error("process interrupted after dispatch");
    });
    const pending = rejection(115);
    await f.notifier.notifyRejections([pending]);
    expect(f.notify.mock.calls[0]![0]).toMatchObject({ allowResend: true });
    expect(phase(pending)).toBe("reserved");
    complete.mockRestore();
    const restartedNotify = vi.fn(consumeNotice);
    f.clock.now = 11_000;
    const { notifier: restarted } = f.start(restartedNotify);
    const reservedNotice = await f.notices.store.loadState(pending);
    expect(reservedNotice).toBeDefined();
    await restarted.notifyRejections([{ ...pending, reservedNotice: reservedNotice! }]);
    expect(restartedNotify.mock.calls[0]![0]).toMatchObject({ allowResend: false });
    expect(phase(pending)).toBe("consumed");
  });
});

it("does not mark an overdue delivery notified until dispatch succeeds", async () => {
  const marked = new Set<string>();
  const entry = {
    peer: "clawd",
    id: "01JZ0000000000000000000151",
    sentAt: Date.now() - 20 * 60_000,
  };
  const store = {
    overdueOutboundDeliveries: vi.fn(() => (marked.has(entry.id) ? [] : [entry])),
    markOutboundDeliveryOverdueNotified: vi.fn((_peer: string, id: string) => {
      const fresh = !marked.has(id);
      marked.add(id);
      return fresh;
    }),
  };
  const failing = vi.fn(async () => {
    throw new Error("enqueue failed");
  });

  await expect(notifyOverdueReefDeliveries({ trust: store, ownerNotice: failing })).rejects.toThrow(
    "enqueue failed",
  );
  expect(store.markOutboundDeliveryOverdueNotified).not.toHaveBeenCalled();

  const ownerNotice = vi.fn<Parameters<typeof notifyOverdueReefDeliveries>[0]["ownerNotice"]>(
    async () => {},
  );
  await notifyOverdueReefDeliveries({ trust: store, ownerNotice });
  expect(ownerNotice).toHaveBeenCalledOnce();
  expect(marked.has(entry.id)).toBe(true);
});
