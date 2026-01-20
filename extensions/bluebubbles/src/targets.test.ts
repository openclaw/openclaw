import { describe, expect, it } from "vitest";

import { looksLikeBlueBubblesTargetId, normalizeBlueBubblesMessagingTarget } from "./targets.js";

describe("normalizeBlueBubblesMessagingTarget", () => {
  it("normalizes chat_guid targets", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:ABC-123")).toBe("chat_guid:ABC-123");
  });

  it("normalizes group numeric targets to chat_id", () => {
    expect(normalizeBlueBubblesMessagingTarget("group:123")).toBe("chat_id:123");
  });

  it("strips provider prefix and normalizes handles", () => {
    expect(normalizeBlueBubblesMessagingTarget("bluebubbles:imessage:User@Example.com")).toBe(
      "imessage:user@example.com",
    );
  });

  it("extracts handle from DM chat_guid for cross-context matching", () => {
    // DM format: service;-;handle
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:iMessage;-;+19257864429")).toBe(
      "+19257864429",
    );
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:SMS;-;+15551234567")).toBe(
      "+15551234567",
    );
    // Email handles
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:iMessage;-;user@example.com")).toBe(
      "user@example.com",
    );
  });

  it("preserves group chat_guid format", () => {
    // Group format: service;+;groupId
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:iMessage;+;chat123456789")).toBe(
      "chat_guid:iMessage;+;chat123456789",
    );
  });
});

describe("looksLikeBlueBubblesTargetId", () => {
  it("accepts chat targets", () => {
    expect(looksLikeBlueBubblesTargetId("chat_guid:ABC-123")).toBe(true);
  });

  it("accepts email handles", () => {
    expect(looksLikeBlueBubblesTargetId("user@example.com")).toBe(true);
  });

  it("accepts phone numbers with punctuation", () => {
    expect(looksLikeBlueBubblesTargetId("+1 (555) 123-4567")).toBe(true);
  });

  it("rejects display names", () => {
    expect(looksLikeBlueBubblesTargetId("Jane Doe")).toBe(false);
  });
});
