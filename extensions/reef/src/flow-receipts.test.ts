import {
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalBytes,
  composeOutbound,
  generateIdentity,
  sha256Hex,
  signReceipt,
} from "../protocol/index.js";
import { MemoryAuditStore, MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  flowStores,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
  transport,
  trust,
} from "./flow.test-helpers.js";
import { reefPeerIdentity } from "./friend-types.js";
import { processReefInboxEntriesInOrder, ReefReceiptNotifier } from "./owner-notice.js";
import type { ReefTransportClient } from "./transport.js";
import type { InboxEntry } from "./types.js";

const schedulers: ReturnType<typeof createTestPluginServiceScheduler>[] = [];

beforeEach(resetFlowStoresForTests);
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.stop()));
  await resetFlowStoresForTests();
});

type FlowOptions = ConstructorParameters<typeof ReefMessageFlow>[0];
type TrustedReef = ReturnType<typeof trust>;

function signedReceipt(
  signer: ReturnType<typeof generateIdentity>,
  payload: Omit<Parameters<typeof signReceipt>[0], "auditHead"> & { auditHead?: string },
) {
  return signReceipt({ auditHead: "b".repeat(64), ...payload }, signer.signing.secretKey);
}

function receiptEntry(receipt: ReturnType<typeof signReceipt>, seq = 1, ts = 1): InboxEntry {
  return { seq, peer: "alice", id: receipt.id, kind: "receipt", receipt, ts };
}

function createFlow(params: {
  alice: ReturnType<typeof generateIdentity>;
  bob: ReturnType<typeof reefKeys>;
  audit: MemoryAuditStore;
  trusted?: TrustedReef;
  relay?: ReturnType<typeof transport>;
  onOwnerNotice?: FlowOptions["onOwnerNotice"];
}): ReefMessageFlow {
  return new ReefMessageFlow({
    config: config(),
    trust: (params.trusted ?? trust({ alice: peerTrust(params.alice) })).store,
    keys: params.bob,
    transport: (params.relay ?? transport()) as unknown as ReefTransportClient,
    guard: guard(allow),
    audit: params.audit,
    replay: new MemoryReplayStore(),
    ...flowStores(),
    onIngress: async () => {},
    onOwnerNotice: params.onOwnerNotice ?? (async () => {}),
  });
}

function createReceiptNotifier(
  trusted: TrustedReef,
  notify: ConstructorParameters<typeof ReefReceiptNotifier>[0],
): ReefReceiptNotifier {
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler());
  schedulers.push(scheduler);
  return new ReefReceiptNotifier(
    notify,
    {
      loadState: (rejection) => rejection.recovery.loadState(),
      reserve: (rejection, noticeState) => rejection.recovery.reserve(noticeState),
      complete: async (rejection, noticeState) => {
        if (!(await rejection.recovery.complete(noticeState))) {
          throw new Error(`missing rejection ${rejection.id}`);
        }
      },
    },
    { scheduler },
  );
}

describe("ReefMessageFlow delivery receipts", () => {
  it("quarantines an unmatched forged receipt without scanning audit history", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(17));
    const entries = vi.spyOn(audit, "entries");
    const flow = createFlow({ alice, bob, audit });
    const id = "01JZ0000000000000000000130";
    const receipt = signedReceipt(bob, {
      id,
      bodyHash: "a".repeat(64),
      status: "rejected",
      category: "guard_deny",
    });

    await expect(flow.processEntries([receiptEntry(receipt)])).resolves.toEqual([]);
    expect(entries).not.toHaveBeenCalled();
  });

  it.each(["accepted", "rejected"] as const)(
    "quarantines historical %s receipts without reconstructing delivery or cooldown state",
    async (status) => {
      const alice = generateIdentity();
      const bob = reefKeys();
      const trusted = trust({ alice: peerTrust(alice) });
      const originalPeer = structuredClone(trusted.values.get("alice"));
      const audit = new MemoryAuditStore(new Uint8Array(32).fill(15));
      const id = "01JZ0000000000000000000127";
      const text = "queued before delivery bindings";
      await composeOutbound({
        id,
        from: "bob#1",
        to: "alice#1",
        body: { text },
        senderSigningSecretKey: bob.signing.secretKey,
        recipientEncryptionPublicKey: alice.encryption.publicKey,
        guard: guard(allow),
        audit,
        policyVersion: "v1",
      });
      const historicalEntries = structuredClone(await audit.entries());
      const auditEntries = vi.spyOn(audit, "entries");
      const flow = createFlow({ alice, bob, audit, trusted });
      const notify = vi.fn(async () => {});
      const receiptNotifier = createReceiptNotifier(trusted, notify);
      const receipt = signedReceipt(alice, {
        id,
        bodyHash: sha256Hex(canonicalBytes({ text })),
        status,
        ...(status === "rejected" ? { category: "guard_deny" } : {}),
      });

      const rejections = await flow.processEntries([receiptEntry(receipt)]);
      expect(rejections).toEqual([]);
      await receiptNotifier.notifyRejections(rejections);
      expect(auditEntries).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(trusted.deliveries.size).toBe(0);
      expect(trusted.rejectionNotices.size).toBe(0);
      expect(trusted.values.get("alice")).toEqual(originalPeer);
      const entries = await audit.entries();
      expect(entries.slice(0, historicalEntries.length)).toEqual(historicalEntries);
      expect(entries.filter((entry) => entry.event.type === "confirm_delivery")).toHaveLength(0);
      expect(
        entries.filter((entry) => entry.event.type === "invalid_delivery_receipt"),
      ).toHaveLength(1);

      const currentId = await flow.send("alice", "sent after the upgrade");
      const currentReceipt = signedReceipt(alice, {
        id: currentId,
        bodyHash: sha256Hex(canonicalBytes({ text: "sent after the upgrade" })),
        status: "rejected",
        category: "guard_deny",
      });
      await receiptNotifier.notifyRejections(
        await flow.processEntries([receiptEntry(currentReceipt, 2)]),
      );
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: currentId, allowResend: true }),
      );
    },
  );

  it("surfaces one resend notice even when a later batch receipt is invalid", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const onOwnerNotice = vi.fn(async () => {});
    const relay = transport();
    const trusted = trust({ alice: peerTrust(alice) });
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(11));
    const flow = createFlow({ alice, bob, audit, trusted, relay });
    const receiptNotifier = createReceiptNotifier(trusted, onOwnerNotice);
    const id = await flow.send("alice", "ordinary coordination");
    const receipt = signedReceipt(alice, {
      id,
      bodyHash: sha256Hex(canonicalBytes({ text: "ordinary coordination" })),
      status: "rejected",
      category: "guard_deny",
    });
    const entry: InboxEntry = receiptEntry(receipt, 1, Math.floor(Date.now() / 1_000));
    const invalidEntry: InboxEntry = {
      seq: 2,
      peer: "alice",
      id: "01JZ0000000000000000000106",
      kind: "receipt",
      receipt: signedReceipt(bob, {
        auditHead: "d".repeat(64),
        id: "01JZ0000000000000000000106",
        bodyHash: "c".repeat(64),
        status: "rejected",
        category: "guard_deny",
      }),
      ts: Math.floor(Date.now() / 1_000),
    };
    const acceptedId = await flow.send("alice", "later coordination");
    const acceptedEntry: InboxEntry = {
      seq: 3,
      peer: "alice",
      id: acceptedId,
      kind: "receipt",
      receipt: signedReceipt(alice, {
        auditHead: "e".repeat(64),
        id: acceptedId,
        bodyHash: sha256Hex(canonicalBytes({ text: "later coordination" })),
        status: "accepted",
      }),
      ts: Math.floor(Date.now() / 1_000),
    };

    await expect(
      processReefInboxEntriesInOrder({
        entries: [entry, invalidEntry, acceptedEntry],
        processEntries: (batch) => flow.processEntries(batch),
        notifyRejections: (rejections) => receiptNotifier.notifyRejections(rejections),
      }),
    ).resolves.toBeUndefined();
    await expect(
      processReefInboxEntriesInOrder({
        entries: [
          { ...entry, seq: 4 },
          { ...invalidEntry, seq: 5 },
        ],
        processEntries: (batch) => flow.processEntries(batch),
        notifyRejections: (rejections) => receiptNotifier.notifyRejections(rejections),
      }),
    ).resolves.toBeUndefined();

    expect(onOwnerNotice).toHaveBeenCalledOnce();
    expect(onOwnerNotice).toHaveBeenCalledWith({
      text: expect.stringMatching(/rejected by the peer's inbound guard.*at most once/),
      peer: "alice",
      messageId: id,
      recipient: reefPeerIdentity(peerTrust(alice)),
      originalTextHash: receipt.bodyHash,
      allowResend: true,
      recovery: expect.any(Object),
    });
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(false);
    expect(trusted.deliveries.has(`alice:${acceptedId}`)).toBe(false);
    expect(trusted.rejectionNotices.get("alice")).toEqual({
      lastRejectionAt: expect.any(Number),
      lastResendAt: expect.any(Number),
    });
    expect(
      (await audit.entries()).filter((item) => item.event.type === "invalid_delivery_receipt"),
    ).toHaveLength(3);
  });

  it("binds receipts and automatic resends to the send-time recipient identity", async () => {
    const alice = generateIdentity();
    const rotatedAlice = generateIdentity();
    const bob = reefKeys();
    const originalTrust = peerTrust(alice);
    const originalRecipient = reefPeerIdentity(originalTrust);
    const trusted = trust({ alice: originalTrust });
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(14));
    const flow = createFlow({ alice, bob, audit, trusted });
    const id = await flow.send("alice", "expected body");
    const bodyHash = sha256Hex(canonicalBytes({ text: "expected body" }));
    trusted.values.set("alice", peerTrust(rotatedAlice, { keyEpoch: 2 }));

    await expect(
      flow.send("alice", "automatic retry", {
        replyTo: id,
        expectedRecipient: originalRecipient,
      }),
    ).rejects.toThrow("not approved with current keys");

    const rotatedReceipt = signedReceipt(rotatedAlice, {
      auditHead: "c".repeat(64),
      id,
      bodyHash,
      status: "rejected",
      category: "guard_deny",
    });
    await expect(flow.processEntries([receiptEntry(rotatedReceipt)])).resolves.toEqual([]);
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(true);
    expect(
      (await audit.entries()).filter((entry) => entry.event.type === "confirm_delivery"),
    ).toHaveLength(0);

    const originalReceipt = signedReceipt(alice, {
      auditHead: "d".repeat(64),
      id,
      bodyHash,
      status: "rejected",
      category: "guard_deny",
    });
    await expect(flow.processEntries([receiptEntry(originalReceipt, 2)])).resolves.toEqual([]);
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(false);
    expect(
      (await audit.entries()).filter((entry) => entry.event.type === "confirm_delivery"),
    ).toHaveLength(1);
  });

  it("quarantines peer-signed receipt conflicts without consuming outbound state", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const trusted = trust({ alice: peerTrust(alice) });
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(13));
    const flow = createFlow({ alice, bob, audit, trusted });
    const id = await flow.send("alice", "expected body");
    const receipt = signedReceipt(alice, {
      auditHead: "d".repeat(64),
      id,
      bodyHash: "c".repeat(64),
      status: "rejected",
      category: "guard_deny",
    });

    await expect(flow.processEntries([receiptEntry(receipt)])).resolves.toEqual([]);
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(true);

    const bodyHash = sha256Hex(canonicalBytes({ text: "expected body" }));
    const rejected = signedReceipt(alice, {
      auditHead: "e".repeat(64),
      id,
      bodyHash,
      status: "rejected",
      category: "guard_deny",
    });
    await expect(flow.processEntries([receiptEntry(rejected, 2)])).resolves.toMatchObject([
      {
        id,
        peer: "alice",
        recipient: reefPeerIdentity(peerTrust(alice)),
        textHash: bodyHash,
        category: "guard_deny",
      },
    ]);

    const conflictingAccepted = signedReceipt(alice, {
      auditHead: "f".repeat(64),
      id,
      bodyHash,
      status: "accepted",
    });
    await expect(flow.processEntries([receiptEntry(conflictingAccepted, 3)])).resolves.toEqual([]);
    expect(trusted.deliveries.get(`alice:${id}`)?.rejection).toEqual({
      category: "guard_deny",
    });
    expect(
      (await audit.entries()).filter((item) => item.event.type === "invalid_delivery_receipt"),
    ).toHaveLength(2);

    const appendEvent = audit.appendEvent.bind(audit);
    vi.spyOn(audit, "appendEvent").mockImplementation(async (type, payload, ts) => {
      if (type === "invalid_delivery_receipt") {
        throw new Error("audit unavailable");
      }
      return await appendEvent(type, payload, ts);
    });
    await expect(flow.processEntries([receiptEntry(conflictingAccepted, 4)])).rejects.toThrow(
      "audit unavailable",
    );
    expect(trusted.deliveries.get(`alice:${id}`)?.rejection).toEqual({
      category: "guard_deny",
    });
  });
});

describe("ReefMessageFlow overdue delivery follow-up", () => {
  it("notifies the owner when an accepted receipt closes an overdue notice", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const trusted = trust({ alice: peerTrust(alice) });
    const relay = transport();
    const onOwnerNotice = vi.fn(async (_text: string) => {});
    const flow = createFlow({
      alice,
      bob,
      audit: new MemoryAuditStore(new Uint8Array(32).fill(23)),
      trusted,
      relay,
      onOwnerNotice,
    });
    const id = await flow.send("alice", "are you there?");
    const record = trusted.deliveries.get(`alice:${id}`)!;
    record.overdueNotifiedAt = Date.now();
    const receipt = signedReceipt(alice, {
      auditHead: "a".repeat(64),
      id,
      bodyHash: record.bodyHash,
      status: "accepted",
    });

    await expect(flow.processEntries([receiptEntry(receipt)])).resolves.toEqual([]);

    expect(trusted.deliveries.has(`alice:${id}`)).toBe(false);
    expect(onOwnerNotice).toHaveBeenCalledOnce();
    expect(onOwnerNotice.mock.calls[0]?.[0]).toContain("delivered after");
  });

  it("stays silent for accepted receipts that were never reported overdue", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const trusted = trust({ alice: peerTrust(alice) });
    const relay = transport();
    const onOwnerNotice = vi.fn(async (_text: string) => {});
    const flow = createFlow({
      alice,
      bob,
      audit: new MemoryAuditStore(new Uint8Array(32).fill(24)),
      trusted,
      relay,
      onOwnerNotice,
    });
    const id = await flow.send("alice", "quick ping");
    const record = trusted.deliveries.get(`alice:${id}`)!;
    const receipt = signedReceipt(alice, {
      auditHead: "a".repeat(64),
      id,
      bodyHash: record.bodyHash,
      status: "accepted",
    });

    await expect(flow.processEntries([receiptEntry(receipt)])).resolves.toEqual([]);
    expect(onOwnerNotice).not.toHaveBeenCalled();
  });
});
