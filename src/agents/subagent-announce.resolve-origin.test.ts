import { describe, expect, it } from "vitest";
import type { DeliveryContext } from "../utils/delivery-context.js";
import type { DeliveryContextSessionSource } from "../utils/delivery-context.js";
import { resolveAnnounceOrigin } from "./subagent-announce.js";

describe("resolveAnnounceOrigin thread routing", () => {
  it("preserves session entry threadId when requester has to but no threadId", () => {
    // Feishu scenario: completion comes back with channel/to but no explicit threadId.
    // The entry has a persisted threadId from the original message.
    // Expected: threadId should be preserved from entry.
    const entry: DeliveryContextSessionSource = {
      lastChannel: "feishu",
      lastTo: "channel:C123",
      lastAccountId: "acc1",
      lastThreadId: "thread-456",
    };

    const requesterOrigin: DeliveryContext = {
      channel: "feishu",
      to: "channel:C123",
      accountId: "acc1",
      // threadId is intentionally absent
    };

    const result = resolveAnnounceOrigin(entry, requesterOrigin);

    expect(result?.threadId).toBe("thread-456");
  });

  it("preserves requester threadId when explicitly provided", () => {
    // When requester explicitly provides a threadId, it should take priority.
    const entry: DeliveryContextSessionSource = {
      lastChannel: "feishu",
      lastTo: "channel:C123",
      lastAccountId: "acc1",
      lastThreadId: "thread-456",
    };

    const requesterOrigin: DeliveryContext = {
      channel: "feishu",
      to: "channel:C123",
      accountId: "acc1",
      threadId: "thread-789",
    };

    const result = resolveAnnounceOrigin(entry, requesterOrigin);

    expect(result?.threadId).toBe("thread-789");
  });

  it("uses entry threadId when requester has no to field", () => {
    // When requester doesn't override the 'to' field, entry's threadId should be preserved.
    const entry: DeliveryContextSessionSource = {
      lastChannel: "feishu",
      lastTo: "channel:C123",
      lastAccountId: "acc1",
      lastThreadId: "thread-456",
    };

    const requesterOrigin: DeliveryContext = {
      channel: "feishu",
      accountId: "acc1",
      // No 'to' field
    };

    const result = resolveAnnounceOrigin(entry, requesterOrigin);

    expect(result?.threadId).toBe("thread-456");
  });

  it("handles missing entry gracefully", () => {
    // When there's no persisted entry, use requester's threadId.
    const requesterOrigin: DeliveryContext = {
      channel: "feishu",
      to: "channel:C123",
      accountId: "acc1",
      threadId: "thread-789",
    };

    const result = resolveAnnounceOrigin(undefined, requesterOrigin);

    expect(result?.threadId).toBe("thread-789");
    expect(result?.channel).toBe("feishu");
  });

  it("handles missing requester gracefully", () => {
    // When there's no requester origin, use entry's threadId.
    const entry: DeliveryContextSessionSource = {
      lastChannel: "feishu",
      lastTo: "channel:C123",
      lastAccountId: "acc1",
      lastThreadId: "thread-456",
    };

    const result = resolveAnnounceOrigin(entry, undefined);

    expect(result?.threadId).toBe("thread-456");
    expect(result?.channel).toBe("feishu");
  });

  it("prefers requester channel over entry channel, and uses requester's to/threadId when channels conflict", () => {
    // When channels conflict (feishu vs whatsapp), the merge function keeps route fields
    // paired to the primary (requester) channel and doesn't cross fields between channels.
    // Since requester has no 'to', the result will have no 'to' (not fallback to entry's).
    const entry: DeliveryContextSessionSource = {
      lastChannel: "whatsapp",
      lastTo: "channel:C123",
      lastAccountId: "acc1",
      lastThreadId: "thread-456",
    };

    const requesterOrigin: DeliveryContext = {
      channel: "feishu",
      accountId: "acc1",
      // No 'to' field
    };

    const result = resolveAnnounceOrigin(entry, requesterOrigin);

    // Channel comes from requester (feishu), but since channels conflict,
    // 'to' and 'threadId' are not crossed from entry (whatsapp).
    expect(result?.channel).toBe("feishu");
    expect(result?.to).toBeUndefined();
    expect(result?.threadId).toBeUndefined();
  });

  it("does not reuse entry threadId when same channel but different to", () => {
    // Regression test: same channel + different 'to' + missing requester threadId
    // should NOT reuse entry's threadId, as it belongs to a different conversation.
    const entry: DeliveryContextSessionSource = {
      lastChannel: "feishu",
      lastTo: "channel:C123",
      lastAccountId: "acc1",
      lastThreadId: "thread-456",
    };

    const requesterOrigin: DeliveryContext = {
      channel: "feishu",
      to: "channel:C999", // Different destination
      accountId: "acc1",
      // threadId is intentionally absent
    };

    const result = resolveAnnounceOrigin(entry, requesterOrigin);

    // Should use requester's 'to' but NOT entry's threadId (different conversation).
    expect(result?.channel).toBe("feishu");
    expect(result?.to).toBe("channel:C999");
    expect(result?.threadId).toBeUndefined();
  });
});
