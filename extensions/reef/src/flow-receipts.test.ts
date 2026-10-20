import {
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalBytes,
  bodyHash,
  prepareOutboundProposal,
  seal,
  generateIdentity,
  sha256Hex,
  signReceipt,
} from "../protocol/index.js";
import { MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
  transport,
  workerFlowStores,
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

function signedReceipt(
  signer: ReturnType<typeof generateIdentity>,
  id: string,
  text = "expected body",
  overrides: Partial<Parameters<typeof signReceipt>[0]> = {},
) {
  const body: Parameters<typeof signReceipt>[0] = {
    auditHead: "b".repeat(64),
    id,
    bodyHash: textHash(text),
    status: "rejected",
    ...(overrides.status === "accepted" ? {} : { category: "guard_deny" }),
    ...overrides,
  };
  return signReceipt(body, signer.signing.secretKey);
}

const textHash = (text: string) => sha256Hex(canonicalBytes({ text }));

function receiptEntry(receipt: ReturnType<typeof signReceipt>, seq = 1, ts = 1): InboxEntry {
  return { seq, peer: "alice", id: receipt.id, kind: "receipt", receipt, ts };
}

async function createFlow(onOwnerNotice: FlowOptions["onOwnerNotice"] = async () => {}) {
  const alice = generateIdentity();
  const bob = reefKeys();
  const { trusted, audit, ...stores } = await workerFlowStores(config(), {
    alice: peerTrust(alice),
  });
  const flow = new ReefMessageFlow({
    config: config(),
    trust: trusted,
    keys: bob,
    transport: transport() as unknown as ReefTransportClient,
    guard: guard(allow),
    audit,
    replay: new MemoryReplayStore(),
    ...stores,
    onIngress: async () => {},
    onOwnerNotice,
  });
  return { flow, trusted, audit, alice, bob };
}

async function eventCount(audit: FlowOptions["audit"], type: string) {
  return (await audit.entries()).filter((entry) => entry.event.type === type).length;
}

function createReceiptNotifier(notify: ConstructorParameters<typeof ReefReceiptNotifier>[0]) {
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
  it("quarantines historical rejected receipts without reconstructing delivery or cooldown state", async () => {
    const { flow, trusted, audit, alice, bob } = await createFlow();
    const originalPeer = await trusted.get("alice");
    const id = "01JZ0000000000000000000127";
    const text = "queued before delivery bindings";
    const proposal = {
      id,
      from: "bob#1",
      to: "alice#1",
      body: { text },
      senderSigningSecretKey: bob.signing.secretKey,
      recipientEncryptionPublicKey: alice.encryption.publicKey,
      policyVersion: "v1",
    };
    const { approvalDigest } = prepareOutboundProposal(proposal, 32);
    await audit.appendEvent("proposal", {
      id,
      from: proposal.from,
      to: proposal.to,
      body: proposal.body,
      bodyHash: bodyHash(proposal.body),
      approvalDigest,
    });
    await audit.appendEvent("guard_verdict", {
      id,
      from: proposal.from,
      to: proposal.to,
      direction: "outbound",
      bodyHash: bodyHash(proposal.body),
      approvalDigest,
      ...allow,
    });
    await audit.appendEvent("envelope", { id, approvalDigest, envelope: seal(proposal) });
    const historicalEntries = structuredClone(await audit.entries());
    const auditEntries = vi.spyOn(audit, "entries");
    const notify = vi.fn(async () => {});
    const notifier = createReceiptNotifier(notify);
    const receipt = signedReceipt(alice, id, text);

    const rejections = await flow.processEntries([receiptEntry(receipt)]);
    expect(rejections).toEqual([]);
    await notifier.notifyRejections(rejections);
    expect(auditEntries).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(await trusted.readOutboundDelivery("alice", id)).toBeUndefined();
    expect(await trusted.rejectionNoticeState("alice")).toBeUndefined();
    expect(await trusted.get("alice")).toEqual(originalPeer);
    const entries = await audit.entries();
    expect(entries.slice(0, historicalEntries.length)).toEqual(historicalEntries);
    expect(entries.filter((entry) => entry.event.type === "confirm_delivery")).toHaveLength(0);
    expect(await eventCount(audit, "invalid_delivery_receipt")).toBe(1);

    const currentId = await flow.send("alice", "sent after the upgrade");
    const currentReceipt = signedReceipt(alice, currentId, "sent after the upgrade");
    await notifier.notifyRejections(await flow.processEntries([receiptEntry(currentReceipt, 2)]));
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: currentId, allowResend: true }),
    );
  });

  it("surfaces one resend notice even when a later batch receipt is invalid", async () => {
    const notify = vi.fn(async () => {});
    const { flow, trusted, audit, alice, bob } = await createFlow();
    const notifier = createReceiptNotifier(notify);
    const id = await flow.send("alice", "ordinary coordination");
    const receipt = signedReceipt(alice, id, "ordinary coordination");
    const ts = Math.floor(Date.now() / 1_000);
    const entry = receiptEntry(receipt, 1, ts);
    const invalidReceipt = signedReceipt(bob, "01JZ0000000000000000000106", "", {
      bodyHash: "c".repeat(64),
    });
    const invalidEntry = receiptEntry(invalidReceipt, 2, ts);
    const acceptedId = await flow.send("alice", "later coordination");
    const accepted = signedReceipt(alice, acceptedId, "later coordination", { status: "accepted" });
    const acceptedEntry = receiptEntry(accepted, 3, ts);

    const process = (entries: InboxEntry[]) =>
      processReefInboxEntriesInOrder({
        entries,
        processEntries: (batch) => flow.processEntries(batch),
        notifyRejections: (rejections) => notifier.notifyRejections(rejections),
      });

    await expect(process([entry, invalidEntry, acceptedEntry])).resolves.toBeUndefined();
    const replay = [
      { ...entry, seq: 4 },
      { ...invalidEntry, seq: 5 },
    ];
    await expect(process(replay)).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({
      text: expect.stringMatching(/rejected by the peer's inbound guard.*at most once/),
      peer: "alice",
      messageId: id,
      recipient: reefPeerIdentity(peerTrust(alice)),
      originalTextHash: receipt.bodyHash,
      allowResend: true,
      recovery: expect.any(Object),
    });
    expect(await trusted.readOutboundDelivery("alice", id)).toBeUndefined();
    expect(await trusted.readOutboundDelivery("alice", acceptedId)).toBeUndefined();
    expect(await trusted.rejectionNoticeState("alice")).toEqual({
      lastRejectionAt: expect.any(Number),
      lastResendAt: expect.any(Number),
    });
    expect(await eventCount(audit, "invalid_delivery_receipt")).toBe(3);
  });

  it("binds receipts and automatic resends to the send-time recipient identity", async () => {
    const rotatedAlice = generateIdentity();
    const { flow, trusted, audit, alice } = await createFlow();
    const originalRecipient = reefPeerIdentity(peerTrust(alice));
    const id = await flow.send("alice", "expected body");
    await trusted.set("alice", peerTrust(rotatedAlice, { keyEpoch: 2 }));

    await expect(
      flow.send("alice", "automatic retry", {
        replyTo: id,
        expectedRecipient: originalRecipient,
      }),
    ).rejects.toThrow("not approved with current keys");

    const rotatedReceipt = signedReceipt(rotatedAlice, id);
    await expect(flow.processEntries([receiptEntry(rotatedReceipt)])).resolves.toEqual([]);
    expect(await trusted.readOutboundDelivery("alice", id)).toBeDefined();
    expect(await eventCount(audit, "confirm_delivery")).toBe(0);

    const originalReceipt = signedReceipt(alice, id);
    await expect(flow.processEntries([receiptEntry(originalReceipt, 2)])).resolves.toEqual([]);
    expect(await trusted.readOutboundDelivery("alice", id)).toBeUndefined();
    expect(await eventCount(audit, "confirm_delivery")).toBe(1);
  });

  it("quarantines peer-signed receipt conflicts without consuming outbound state", async () => {
    const { flow, trusted, audit, alice } = await createFlow();
    const id = await flow.send("alice", "expected body");
    const delivery = () => trusted.readOutboundDelivery("alice", id);
    const receipt = signedReceipt(alice, id, "expected body", {
      bodyHash: "c".repeat(64),
    });

    await expect(flow.processEntries([receiptEntry(receipt)])).resolves.toEqual([]);
    expect(await delivery()).toBeDefined();

    const rejected = signedReceipt(alice, id);
    await expect(flow.processEntries([receiptEntry(rejected, 2)])).resolves.toMatchObject([
      {
        id,
        peer: "alice",
        recipient: reefPeerIdentity(peerTrust(alice)),
        textHash: textHash("expected body"),
        category: "guard_deny",
      },
    ]);

    const accepted = signedReceipt(alice, id, "expected body", { status: "accepted" });
    await expect(flow.processEntries([receiptEntry(accepted, 3)])).resolves.toEqual([]);
    const rejection = { category: "guard_deny" };
    expect((await delivery())?.delivery.rejection).toEqual(rejection);
    expect(await eventCount(audit, "invalid_delivery_receipt")).toBe(2);

    const appendEvent = audit.appendEvent.bind(audit);
    vi.spyOn(audit, "appendEvent").mockImplementation(async (type, payload, ts) => {
      if (type === "invalid_delivery_receipt") {
        throw new Error("audit unavailable");
      }
      return await appendEvent(type, payload, ts);
    });
    await expect(flow.processEntries([receiptEntry(accepted, 4)])).rejects.toThrow(
      "audit unavailable",
    );
    expect((await delivery())?.delivery.rejection).toEqual(rejection);
  });
  it("notifies the owner when an accepted receipt closes an overdue notice", async () => {
    const onOwnerNotice = vi.fn(async (_text: string) => {});
    const { flow, trusted, alice } = await createFlow(onOwnerNotice);
    const id = await flow.send("alice", "are you there?");
    const record = (await trusted.readOutboundDelivery("alice", id))!.delivery;
    await trusted.markOutboundDeliveryOverdueNotified("alice", id);
    const receipt = signedReceipt(alice, id, "are you there?", {
      bodyHash: record.bodyHash,
      status: "accepted",
    });

    await expect(flow.processEntries([receiptEntry(receipt)])).resolves.toEqual([]);

    expect(await trusted.readOutboundDelivery("alice", id)).toBeUndefined();
    expect(onOwnerNotice).toHaveBeenCalledOnce();
    expect(onOwnerNotice.mock.calls[0]?.[0]).toContain("delivered after");
  });
});
