import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createReefOwnerNoticeHandler,
  processReefInboxEntriesInOrder,
  ReefReceiptNotifier,
} from "./owner-notice.js";
import type { InboxEntry, ReefDeliveryRejection } from "./types.js";

function rejection(peer: string, id: string): ReefDeliveryRejection {
  return {
    peer,
    id,
    category: "guard_deny",
  };
}

describe("createReefOwnerNoticeHandler", () => {
  it("queues a rejection in the peer session and wakes that agent", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.routing.resolveAgentRoute).mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:reef:direct:alice",
    });
    vi.mocked(runtime.system.enqueueSystemEvent).mockReturnValue(true);
    const notify = createReefOwnerNoticeHandler({
      runtime,
      cfg: {},
      accountId: "default",
      handle: "bob",
    });

    await notify({
      text: "delivery rejected",
      peer: "alice",
      contextKey: "reef:delivery-rejected:01jz0000000000000000000105",
      wakeAgent: true,
    });

    expect(runtime.channel.routing.resolveAgentRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "reef",
      accountId: "default",
      peer: { kind: "direct", id: "alice" },
    });
    expect(runtime.system.enqueueSystemEvent).toHaveBeenCalledWith("delivery rejected", {
      sessionKey: "agent:main:reef:direct:alice",
      contextKey: "reef:delivery-rejected:01jz0000000000000000000105",
    });
    expect(runtime.system.requestHeartbeat).toHaveBeenCalledWith({
      source: "other",
      intent: "immediate",
      reason: "reef:delivery-rejected",
      agentId: "main",
      sessionKey: "agent:main:reef:direct:alice",
    });
  });

  it("does not wake when the same notice is already queued", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.system.enqueueSystemEvent).mockReturnValue(false);
    const notify = createReefOwnerNoticeHandler({
      runtime,
      cfg: {},
      accountId: "default",
      handle: "bob",
    });

    await notify({
      text: "delivery rejected",
      contextKey: "reef:delivery-rejected:01jz0000000000000000000105",
      wakeAgent: true,
    });

    expect(runtime.system.requestHeartbeat).not.toHaveBeenCalled();
  });
});

describe("processReefInboxEntriesInOrder", () => {
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
        return entry === receipt ? [rejection("alice", entry.id)] : [];
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
    expect(onNoticeError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "notice failed" }),
    );
  });
});

describe("ReefReceiptNotifier", () => {
  it("wakes once per peer cooldown and tells later retries to stop", async () => {
    const notify = vi.fn(async () => {});
    const complete = vi.fn();
    let now = 10_000;
    const notifier = new ReefReceiptNotifier(notify, complete, {
      now: () => now,
    });
    const first = rejection("alice", "01JZ0000000000000000000105");
    const second = rejection("alice", "01JZ0000000000000000000107");
    const later = rejection("alice", "01JZ0000000000000000000108");

    await notifier.notifyRejections([first, second, first]);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: expect.stringMatching(/at most once.*stop and wait for owner guidance/i),
      peer: "alice",
      wakeAgent: true,
    });
    expect(notify.mock.calls[1]![0]).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries and wait for owner guidance/),
      peer: "alice",
      wakeAgent: false,
    });

    now += 15 * 60 * 1_000;
    await notifier.notifyRejections([later]);

    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[2]![0]).toMatchObject({ wakeAgent: true });
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("retries a failed notice once without blocking inbox progress", async () => {
    const error = new Error("queue unavailable");
    const notify = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const complete = vi.fn();
    const scheduled: Array<() => Promise<void>> = [];
    const notifier = new ReefReceiptNotifier(notify, complete, {
      schedule: (task, delayMs) => {
        expect(delayMs).toBe(1_000);
        scheduled.push(task);
      },
      onError,
    });

    await expect(
      notifier.notifyRejections([rejection("alice", "01JZ0000000000000000000109")]),
    ).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error, "01JZ0000000000000000000109");
    expect(scheduled).toHaveLength(1);

    await scheduled[0]!();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveLength(1);

    notify.mockResolvedValueOnce(undefined);
    await notifier.notifyRejections([rejection("alice", "01JZ0000000000000000000110")]);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[2]![0]).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries/),
      wakeAgent: true,
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("keeps a superseded rejection pending until replacement guidance is queued", async () => {
    const error = new Error("queue unavailable");
    const notify = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);
    const complete = vi.fn();
    const scheduled: Array<() => Promise<void>> = [];
    const notifier = new ReefReceiptNotifier(notify, complete, {
      now: () => 10_000,
      schedule: (task) => scheduled.push(task),
    });

    await notifier.notifyRejections([rejection("alice", "01JZ0000000000000000000111")]);
    await notifier.notifyRejections([rejection("alice", "01JZ0000000000000000000112")]);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries/),
      wakeAgent: true,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(2);

    await scheduled[0]!();
    expect(notify).toHaveBeenCalledTimes(2);

    await scheduled[1]!();
    expect(notify).toHaveBeenCalledTimes(3);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("keeps a notice pending until durable completion succeeds", async () => {
    const notify = vi.fn(async () => {});
    const completionError = new Error("state unavailable");
    const complete = vi.fn().mockImplementationOnce(() => {
      throw completionError;
    });
    const onError = vi.fn();
    const scheduled: Array<() => Promise<void>> = [];
    const notifier = new ReefReceiptNotifier(notify, complete, {
      schedule: (task) => scheduled.push(task),
      onError,
    });
    const pending = rejection("alice", "01JZ0000000000000000000114");

    await notifier.notifyRejections([pending]);

    expect(notify).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(completionError, pending.id);
    expect(scheduled).toHaveLength(1);

    await scheduled[0]!();
    expect(notify).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
