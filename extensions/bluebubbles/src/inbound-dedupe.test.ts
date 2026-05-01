import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetBlueBubblesInboundDedupForTest,
  claimBlueBubblesInboundMessage,
  commitBlueBubblesCoalescedMessageIds,
  resolveBlueBubblesInboundDedupeKey,
} from "./inbound-dedupe.js";

type TestMessage = Parameters<typeof claimBlueBubblesInboundMessage>[0]["message"];

function newMessage(messageId: string | undefined): TestMessage {
  return { messageId, eventType: "new-message" };
}

function updatedMessage(
  messageId: string | undefined,
  attachments: TestMessage["attachments"] = [],
): TestMessage {
  return { messageId, eventType: "updated-message", attachments };
}

async function claimAndFinalize(message: TestMessage, accountId: string): Promise<string> {
  const claim = await claimBlueBubblesInboundMessage({ message, accountId });
  if (claim.kind === "claimed") {
    await claim.finalize();
  }
  return claim.kind;
}

describe("claimBlueBubblesInboundMessage", () => {
  beforeEach(() => {
    _resetBlueBubblesInboundDedupForTest();
  });

  it("claims a new guid and rejects committed duplicates", async () => {
    expect(await claimAndFinalize(newMessage("g1"), "acc")).toBe("claimed");
    expect(await claimAndFinalize(newMessage("g1"), "acc")).toBe("duplicate");
  });

  it("scopes dedupe per account", async () => {
    expect(await claimAndFinalize(newMessage("g1"), "a")).toBe("claimed");
    expect(await claimAndFinalize(newMessage("g1"), "b")).toBe("claimed");
  });

  it("reports skip when guid is missing or blank", async () => {
    expect(
      (await claimBlueBubblesInboundMessage({ message: newMessage(undefined), accountId: "acc" }))
        .kind,
    ).toBe("skip");
    expect(
      (await claimBlueBubblesInboundMessage({ message: newMessage(""), accountId: "acc" })).kind,
    ).toBe("skip");
    expect(
      (await claimBlueBubblesInboundMessage({ message: newMessage("   "), accountId: "acc" })).kind,
    ).toBe("skip");
  });

  it("rejects overlong guids to cap on-disk size", async () => {
    const huge = "x".repeat(10_000);
    expect(
      (await claimBlueBubblesInboundMessage({ message: newMessage(huge), accountId: "acc" })).kind,
    ).toBe("skip");
  });

  it("releases the claim so a later replay can retry after a transient failure", async () => {
    const first = await claimBlueBubblesInboundMessage({
      message: newMessage("g1"),
      accountId: "acc",
    });
    expect(first.kind).toBe("claimed");
    if (first.kind === "claimed") {
      first.release();
    }
    // Released claims should be re-claimable on the next delivery.
    expect(await claimAndFinalize(newMessage("g1"), "acc")).toBe("claimed");
  });

  it("treats no-attachment updated-message follow-ups as duplicates once the base GUID committed", async () => {
    // Original new-message: agent processes and replies, base GUID gets committed.
    expect(await claimAndFinalize(newMessage("g1"), "acc")).toBe("claimed");
    // Follow-up updated-message with no attachments for the same GUID: even
    // though `g1:updated` has never been claimed, the base commit is enough to
    // recognize replay noise so it cannot re-trigger a reply (especially after
    // losing group chat context).
    expect(await claimAndFinalize(updatedMessage("g1"), "acc")).toBe("duplicate");
  });

  it("preserves late attachment-bearing updated-message processing after the base committed", async () => {
    // Attachment indexing can arrive after the initial text-only event; this
    // path must stay claimable even when the new-message base GUID committed.
    expect(await claimAndFinalize(newMessage("g1"), "acc")).toBe("claimed");
    expect(
      await claimAndFinalize(
        updatedMessage("g1", [{ guid: "att-1", mimeType: "image/png" }]),
        "acc",
      ),
    ).toBe("claimed");
    expect(
      await claimAndFinalize(
        updatedMessage("g1", [{ guid: "att-1", mimeType: "image/png" }]),
        "acc",
      ),
    ).toBe("duplicate");
  });

  it("lets an updated-message-first webhook through when the base GUID was never committed", async () => {
    // Rare case: BlueBubbles delivers only the updated-message webhook (e.g.
    // attachment-only path with no preceding new-message). Without a prior
    // base commit, the suffixed key proceeds normally so the agent still sees
    // the message.
    expect(await claimAndFinalize(updatedMessage("g1"), "acc")).toBe("claimed");
    // A subsequent updated-message with the same GUID is a duplicate via the
    // standard `:updated` key dedupe.
    expect(await claimAndFinalize(updatedMessage("g1"), "acc")).toBe("duplicate");
  });
});

describe("commitBlueBubblesCoalescedMessageIds", () => {
  beforeEach(() => {
    _resetBlueBubblesInboundDedupForTest();
  });

  it("marks every coalesced source messageId as seen so a later replay dedupes", async () => {
    // Primary was processed via claim+finalize by the debouncer flush.
    expect(await claimAndFinalize(newMessage("primary"), "acc")).toBe("claimed");
    // Secondaries reach dedupe through the bulk-commit path.
    await commitBlueBubblesCoalescedMessageIds({
      messageIds: ["secondary-1", "secondary-2"],
      accountId: "acc",
    });
    // A MessagePoller replay of any individual source event is now a duplicate
    // rather than a fresh agent turn — the core bug this helper exists to fix.
    expect(await claimAndFinalize(newMessage("primary"), "acc")).toBe("duplicate");
    expect(await claimAndFinalize(newMessage("secondary-1"), "acc")).toBe("duplicate");
    expect(await claimAndFinalize(newMessage("secondary-2"), "acc")).toBe("duplicate");
  });

  it("scopes coalesced commits per account", async () => {
    await commitBlueBubblesCoalescedMessageIds({
      messageIds: ["g1"],
      accountId: "a",
    });
    // Same messageId under a different account is still claimable.
    expect(await claimAndFinalize(newMessage("g1"), "a")).toBe("duplicate");
    expect(await claimAndFinalize(newMessage("g1"), "b")).toBe("claimed");
  });

  it("skips empty or overlong guids without throwing", async () => {
    await commitBlueBubblesCoalescedMessageIds({
      messageIds: ["", "   ", "x".repeat(10_000), "valid"],
      accountId: "acc",
    });
    expect(await claimAndFinalize(newMessage("valid"), "acc")).toBe("duplicate");
    // Overlong guid was skipped by sanitization, not committed.
    expect(await claimAndFinalize(newMessage("x".repeat(10_000)), "acc")).toBe("skip");
  });
});

describe("resolveBlueBubblesInboundDedupeKey", () => {
  it("returns messageId for new-message events", () => {
    expect(resolveBlueBubblesInboundDedupeKey({ messageId: "msg-1" })).toBe("msg-1");
  });

  it("returns associatedMessageGuid for balloon events", () => {
    expect(
      resolveBlueBubblesInboundDedupeKey({
        messageId: "balloon-1",
        balloonBundleId: "com.apple.messages.URLBalloonProvider",
        associatedMessageGuid: "msg-1",
      }),
    ).toBe("msg-1");
  });

  it("suffixes key with :updated for updated-message events", () => {
    expect(
      resolveBlueBubblesInboundDedupeKey({ messageId: "msg-1", eventType: "updated-message" }),
    ).toBe("msg-1:updated");
  });

  it("updated-message and new-message for same GUID produce distinct keys", () => {
    const newKey = resolveBlueBubblesInboundDedupeKey({ messageId: "msg-1" });
    const updatedKey = resolveBlueBubblesInboundDedupeKey({
      messageId: "msg-1",
      eventType: "updated-message",
    });
    expect(newKey).not.toBe(updatedKey);
  });

  it("returns undefined when messageId is missing", () => {
    expect(resolveBlueBubblesInboundDedupeKey({})).toBeUndefined();
  });
});
