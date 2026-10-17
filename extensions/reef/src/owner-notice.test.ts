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
  function createScheduler() {
    const scheduler = createTestPluginServiceScheduler();
    schedulers.push(scheduler);
    return scheduler;
  }
  function notifierFixture(
    notices = createNoticeStore(),
    notify = vi.fn(consumeNotice),
    options: Partial<ConstructorParameters<typeof ReefReceiptNotifier>[2]> = {},
  ) {
    const notifier = new ReefReceiptNotifier(notify, notices.store, {
      scheduler: createScheduler(),
      now: () => 10_000,
      ...options,
    });
    return { notices, notify, notifier };
  }
  function expectResends(
    notify: ReturnType<typeof vi.fn<typeof consumeNotice>>,
    ...allowed: boolean[]
  ) {
    expect(notify.mock.calls.map(([notice]) => notice.allowResend)).toEqual(allowed);
  }
  function expectStopOnly(notice: ReefRejectionNotice) {
    expect(notice).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries/),
      allowResend: false,
    });
  }
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.stop()));
    vi.useRealTimers();
  });
  it("extends the resend cooldown from every rejection", async () => {
    let now = 10_000;
    const { notify, notifier } = notifierFixture(undefined, undefined, { now: () => now });
    const first = rejection(105);
    const second = rejection(107);
    const third = rejection(108);
    const later = rejection(109);

    await notifier.notifyRejections([first, first]);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: expect.stringMatching(/at most once.*stop and wait for owner guidance/i),
      peer: "alice",
      messageId: first.id,
      allowResend: true,
    });
    now += 14 * 60 * 1_000;
    await notifier.notifyRejections([second]);
    expectStopOnly(notify.mock.calls[1]![0]);

    now += 2 * 60 * 1_000;
    await notifier.notifyRejections([third]);
    expect(notify.mock.calls[2]![0]).toMatchObject({ allowResend: false });

    now += 15 * 60 * 1_000;
    await notifier.notifyRejections([later]);
    expect(notify.mock.calls[3]![0]).toMatchObject({ allowResend: true });
  });

  it.each([
    { reason: "non-guard rejection", category: "deterministic_deny", textHash: "a".repeat(64) },
    { reason: "missing send-time fingerprint", category: "guard_deny", textHash: undefined },
  ])("never grants a resend for $reason", async ({ category, textHash }) => {
    const { notify, notifier } = notifierFixture();
    await notifier.notifyRejections([{ ...rejection(110, category), textHash }]);
    expectStopOnly(notify.mock.calls[0]![0]);
  });

  it.each([
    ["applies recovered reservations before fresh items", 11_000, false],
    ["fails closed when recovered state cannot be loaded", 1_000_000, true],
  ] as const)("%s", async (_name, now, loadFails) => {
    const notices = createNoticeStore();
    const recovered = rejection(111);
    const reservedNotice = { lastRejectionAt: 10_000, lastResendAt: 10_000 };
    await notices.store.reserve(recovered, reservedNotice);
    const loadError = new Error("state unavailable");
    if (loadFails) {
      vi.spyOn(notices.store, "loadState").mockImplementationOnce(() => {
        throw loadError;
      });
    }
    const onError = vi.fn();
    const { notify, notifier } = notifierFixture(notices, undefined, { now: () => now, onError });
    await notifier.notifyRejections([rejection(112), { ...recovered, reservedNotice }]);
    if (loadFails) {
      expect(onError).toHaveBeenCalledWith(loadError, recovered.id);
    }
    expectResends(notify, false, false);
  });

  it("preserves the fresh resend cooldown when recovery starts during state loading", async () => {
    const notices = createNoticeStore();
    const recovered = rejection(131);
    const reservedNotice = { lastRejectionAt: 10_000, lastResendAt: 10_000 };
    await notices.store.reserve(recovered, reservedNotice);
    const captured = await notices.store.loadState(rejection("cooldown"));
    const loadStarted = createDeferred<void>();
    const loadFinished = createDeferred<ReefRejectionNoticeState | undefined>();
    vi.spyOn(notices.store, "loadState").mockImplementationOnce(() => {
      loadStarted.resolve();
      return loadFinished.promise;
    });
    let now = 1_000_000;
    const { notify, notifier } = notifierFixture(notices, undefined, { now: () => now });
    const fresh = rejection(132);
    const later = rejection(133);

    const freshNotification = notifier.notifyRejections([fresh]);
    await loadStarted.promise;
    const recoveredNotification = notifier.notifyRejections([{ ...recovered, reservedNotice }]);
    loadFinished.resolve(captured);
    await Promise.all([freshNotification, recoveredNotification]);
    now += 1;
    await notifier.notifyRejections([later]);

    expect(
      notify.mock.calls.map(([notice]) => ({
        messageId: notice.messageId,
        allowResend: notice.allowResend,
      })),
    ).toEqual([
      { messageId: fresh.id, allowResend: true },
      { messageId: recovered.id, allowResend: false },
      { messageId: later.id, allowResend: false },
    ]);
  });

  it("keeps cached cooldown time monotonic after a backward clock adjustment", async () => {
    const notices = createNoticeStore();
    const previous = rejection(113, "deterministic_deny");
    await notices.store.reserve(previous, { lastRejectionAt: 1_000_000 });
    await notices.store.complete(previous, { lastRejectionAt: 1_000_000 });
    let now = 900_000;
    const { notify, notifier } = notifierFixture(notices, undefined, { now: () => now });

    await notifier.notifyRejections([rejection(114)]);
    now = 1_800_000;
    await notifier.notifyRejections([rejection(115)]);

    expectResends(notify, false, false);
  });

  it.each(["loadState", "reserve"] as const)(
    "retries a fresh rejection on reconciliation after durable %s rejects",
    async (operation) => {
      const notices = createNoticeStore();
      const stateError = new Error("state unavailable");
      vi.spyOn(notices.store, operation).mockRejectedValueOnce(stateError);
      const onError = vi.fn();
      const { notify, notifier } = notifierFixture(notices, undefined, { onError });
      const pending = rejection(124);

      await notifier.notifyRejections([pending]);
      expect(notify).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await notifier.notifyRejections([pending]);

      expect(onError).toHaveBeenCalledWith(stateError, pending.id);
      expect(notify).toHaveBeenCalledOnce();
    },
  );

  it("keeps a failed dispatch reserved and retries with stop-only guidance", async () => {
    const notices = createNoticeStore();
    const notify = vi.fn(consumeNotice).mockRejectedValueOnce(new Error("dispatch interrupted"));
    const { notifier } = notifierFixture(notices, notify);
    const pending = rejection(109);

    await notifier.notifyRejections([pending]);
    expect(notices.records.get(`${pending.peer}:${pending.id}`)?.phase).toBe("reserved");
    expect(vi.getTimerCount()).toBe(0);
    await notifier.notifyRejections([pending]);

    expect(notify).toHaveBeenCalledTimes(2);
    expectStopOnly(notify.mock.calls[1]![0]);
    expect(notices.records.get(`${pending.peer}:${pending.id}`)?.phase).toBe("consumed");
  });

  it("does not retry a notice after the account stops", async () => {
    const notices = createNoticeStore();
    const notify = vi.fn(consumeNotice).mockRejectedValue(new Error("dispatch unavailable"));
    const scheduler = createScheduler();
    const notifier = new ReefReceiptNotifier(notify, notices.store, { scheduler });
    const pending = rejection(126);
    await notifier.notifyRejections([pending]);
    await scheduler.stop();
    await notifier.notifyRejections([pending]);
    expect(notify).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers a crash after agent consumption without granting another resend", async () => {
    const notices = createNoticeStore();
    const complete = vi.spyOn(notices.store, "complete").mockImplementationOnce(() => {
      throw new Error("process interrupted after dispatch");
    });
    const firstNotify = vi.fn(consumeNotice);
    const pending = rejection(115);
    const { notifier: first } = notifierFixture(notices, firstNotify);

    await first.notifyRejections([pending]);
    expect(firstNotify.mock.calls[0]![0]).toMatchObject({ allowResend: true });
    expect(notices.records.get(`${pending.peer}:${pending.id}`)?.phase).toBe("reserved");

    complete.mockRestore();
    const restartedNotify = vi.fn(consumeNotice);
    const { notifier: restarted } = notifierFixture(notices, restartedNotify, {
      now: () => 11_000,
    });
    const reservedNotice = await notices.store.loadState(pending);
    expect(reservedNotice).toBeDefined();
    await restarted.notifyRejections([{ ...pending, reservedNotice: reservedNotice! }]);

    expect(restartedNotify.mock.calls[0]![0]).toMatchObject({ allowResend: false });
    expect(notices.records.get(`${pending.peer}:${pending.id}`)?.phase).toBe("consumed");
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
