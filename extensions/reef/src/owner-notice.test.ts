import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { generateIdentity, signReceipt } from "../protocol/index.js";
import type { ReefPeerTrust } from "./friend-types.js";
import {
  createReefOwnerNoticeHandler,
  processReefInboxEntriesInOrder,
  ReefReceiptNotifier,
} from "./owner-notice.js";
import type { ReefTrustStore } from "./trust-store.js";
import type { InboxEntry } from "./types.js";

function rejectedReceipt(
  peer: string,
  identity: ReturnType<typeof generateIdentity>,
  id: string,
): InboxEntry {
  return {
    seq: 1,
    peer,
    id,
    kind: "receipt",
    receipt: signReceipt(
      {
        id,
        bodyHash: "a".repeat(64),
        auditHead: "b".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      identity.signing.secretKey,
    ),
    ts: 1,
  };
}

function trustFor(peer: string, identity: ReturnType<typeof generateIdentity>): ReefTrustStore {
  const friend: ReefPeerTrust = {
    autonomy: "bounded",
    ed25519PublicKey: identity.signing.publicKey,
    x25519PublicKey: identity.encryption.publicKey,
    keyEpoch: 1,
    safetyNumberChanged: false,
    approvedAt: 1,
  };
  return {
    get: (candidate: string) => (candidate === peer ? friend : undefined),
  } as ReefTrustStore;
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
      notifyVerified: async ([entry]) => {
        order.push(`notice:${entry!.id}`);
        if (entry === receipt) {
          throw new Error("notice failed");
        }
      },
      processEntries: async ([entry]) => {
        order.push(`process:${entry!.id}`);
      },
      onNoticeError,
    });

    expect(order).toEqual([
      "notice:message",
      "process:message",
      "notice:receipt",
      "process:receipt",
      "notice:later",
      "process:later",
    ]);
    expect(onNoticeError).toHaveBeenCalledOnce();
    expect(onNoticeError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "notice failed" }),
    );
  });
});

describe("ReefReceiptNotifier", () => {
  it("wakes once per peer cooldown and tells later retries to stop", async () => {
    const alice = generateIdentity();
    const notify = vi.fn(async () => {});
    let now = 10_000;
    const notifier = new ReefReceiptNotifier(trustFor("alice", alice), notify, {
      now: () => now,
    });
    const first = rejectedReceipt("alice", alice, "01JZ0000000000000000000105");
    const second = rejectedReceipt("alice", alice, "01JZ0000000000000000000107");
    const later = rejectedReceipt("alice", alice, "01JZ0000000000000000000108");

    await notifier.notifyVerified([first, second, first]);

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
    await notifier.notifyVerified([later]);

    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[2]![0]).toMatchObject({ wakeAgent: true });
  });

  it("retries a failed notice once without blocking inbox progress", async () => {
    const alice = generateIdentity();
    const error = new Error("queue unavailable");
    const notify = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const scheduled: Array<() => Promise<void>> = [];
    const notifier = new ReefReceiptNotifier(trustFor("alice", alice), notify, {
      schedule: (task, delayMs) => {
        expect(delayMs).toBe(1_000);
        scheduled.push(task);
      },
      onError,
    });

    await expect(
      notifier.notifyVerified([rejectedReceipt("alice", alice, "01JZ0000000000000000000109")]),
    ).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error, "01JZ0000000000000000000109");
    expect(scheduled).toHaveLength(1);

    await scheduled[0]!();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveLength(1);

    notify.mockResolvedValueOnce(undefined);
    await notifier.notifyVerified([rejectedReceipt("alice", alice, "01JZ0000000000000000000110")]);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[2]![0]).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries/),
      wakeAgent: true,
    });
  });

  it("cancels stale retry guidance when a later rejection is handled", async () => {
    const alice = generateIdentity();
    const error = new Error("queue unavailable");
    const notify = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const scheduled: Array<() => Promise<void>> = [];
    const notifier = new ReefReceiptNotifier(trustFor("alice", alice), notify, {
      now: () => 10_000,
      schedule: (task) => scheduled.push(task),
    });

    await notifier.notifyVerified([rejectedReceipt("alice", alice, "01JZ0000000000000000000111")]);
    await notifier.notifyVerified([rejectedReceipt("alice", alice, "01JZ0000000000000000000112")]);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries/),
      wakeAgent: true,
    });

    await scheduled[0]!();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
