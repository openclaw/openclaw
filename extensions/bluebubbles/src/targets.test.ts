import { describe, expect, it } from "vitest";

import {
  looksLikeBlueBubblesTargetId,
  normalizeBlueBubblesMessagingTarget,
  parseBlueBubblesTarget,
  parseBlueBubblesAllowTarget,
} from "./targets.js";

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

  it("normalizes raw chat_guid values", () => {
    expect(normalizeBlueBubblesMessagingTarget("iMessage;+;chat660250192681427962")).toBe(
      "chat_guid:iMessage;+;chat660250192681427962",
    );
    expect(normalizeBlueBubblesMessagingTarget("iMessage;-;+19257864429")).toBe("+19257864429");
  });

  it("normalizes chat<digits> pattern to chat_identifier format", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat660250192681427962")).toBe(
      "chat_identifier:chat660250192681427962",
    );
    expect(normalizeBlueBubblesMessagingTarget("chat123")).toBe("chat_identifier:chat123");
    expect(normalizeBlueBubblesMessagingTarget("Chat456789")).toBe("chat_identifier:Chat456789");
  });

  it("normalizes UUID/hex chat identifiers", () => {
    expect(normalizeBlueBubblesMessagingTarget("8b9c1a10536d4d86a336ea03ab7151cc")).toBe(
      "chat_identifier:8b9c1a10536d4d86a336ea03ab7151cc",
    );
    expect(normalizeBlueBubblesMessagingTarget("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toBe(
      "chat_identifier:1C2D3E4F-1234-5678-9ABC-DEF012345678",
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

  it("accepts raw chat_guid values", () => {
    expect(looksLikeBlueBubblesTargetId("iMessage;+;chat660250192681427962")).toBe(true);
  });

  it("accepts chat<digits> pattern as chat_id", () => {
    expect(looksLikeBlueBubblesTargetId("chat660250192681427962")).toBe(true);
    expect(looksLikeBlueBubblesTargetId("chat123")).toBe(true);
    expect(looksLikeBlueBubblesTargetId("Chat456789")).toBe(true);
  });

  it("accepts UUID/hex chat identifiers", () => {
    expect(looksLikeBlueBubblesTargetId("8b9c1a10536d4d86a336ea03ab7151cc")).toBe(true);
    expect(looksLikeBlueBubblesTargetId("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toBe(true);
  });

  it("rejects display names", () => {
    expect(looksLikeBlueBubblesTargetId("Jane Doe")).toBe(false);
  });
});

describe("parseBlueBubblesTarget", () => {
  it("parses chat<digits> pattern as chat_identifier", () => {
    expect(parseBlueBubblesTarget("chat660250192681427962")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "chat660250192681427962",
    });
    expect(parseBlueBubblesTarget("chat123")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "chat123",
    });
    expect(parseBlueBubblesTarget("Chat456789")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "Chat456789",
    });
  });

  it("parses UUID/hex chat identifiers as chat_identifier", () => {
    expect(parseBlueBubblesTarget("8b9c1a10536d4d86a336ea03ab7151cc")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "8b9c1a10536d4d86a336ea03ab7151cc",
    });
    expect(parseBlueBubblesTarget("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "1C2D3E4F-1234-5678-9ABC-DEF012345678",
    });
  });

  it("parses explicit chat_id: prefix", () => {
    expect(parseBlueBubblesTarget("chat_id:123")).toEqual({ kind: "chat_id", chatId: 123 });
  });

  it("parses phone numbers as handles", () => {
    expect(parseBlueBubblesTarget("+19257864429")).toEqual({
      kind: "handle",
      to: "+19257864429",
      service: "auto",
    });
  });

  it("parses raw chat_guid format", () => {
    expect(parseBlueBubblesTarget("iMessage;+;chat660250192681427962")).toEqual({
      kind: "chat_guid",
      chatGuid: "iMessage;+;chat660250192681427962",
    });
  });
});

describe("parseBlueBubblesAllowTarget", () => {
  it("parses chat<digits> pattern as chat_identifier", () => {
    expect(parseBlueBubblesAllowTarget("chat660250192681427962")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "chat660250192681427962",
    });
    expect(parseBlueBubblesAllowTarget("chat123")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "chat123",
    });
  });

  it("parses UUID/hex chat identifiers as chat_identifier", () => {
    expect(parseBlueBubblesAllowTarget("8b9c1a10536d4d86a336ea03ab7151cc")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "8b9c1a10536d4d86a336ea03ab7151cc",
    });
    expect(parseBlueBubblesAllowTarget("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "1C2D3E4F-1234-5678-9ABC-DEF012345678",
    });
  });

  it("parses explicit chat_id: prefix", () => {
    expect(parseBlueBubblesAllowTarget("chat_id:456")).toEqual({ kind: "chat_id", chatId: 456 });
  });

  it("parses phone numbers as handles", () => {
    expect(parseBlueBubblesAllowTarget("+19257864429")).toEqual({
      kind: "handle",
      handle: "+19257864429",
    });
  });
});
