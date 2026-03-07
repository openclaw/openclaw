import { describe, expect, it } from "vitest";
import { parseIMessageReactionNotification } from "./parse-notification.js";

describe("parseIMessageReactionNotification", () => {
  it("parses a valid reaction payload", () => {
    const result = parseIMessageReactionNotification({
      reaction: {
        target_id: 42,
        chat_id: 7,
        sender: "+15551234567",
        is_from_me: false,
        reaction_type: "love",
        added: true,
        target_text: "Hello there",
        created_at: "2026-03-07T12:00:00Z",
        chat_identifier: "iMessage;-;+15551234567",
        chat_guid: "iMessage;-;+15551234567",
        chat_name: null,
        participants: ["+15551234567"],
        is_group: false,
      },
    });
    expect(result).not.toBeNull();
    expect(result!.reaction_type).toBe("love");
    expect(result!.sender).toBe("+15551234567");
    expect(result!.target_id).toBe(42);
    expect(result!.added).toBe(true);
  });

  it("returns null for missing reaction key", () => {
    expect(parseIMessageReactionNotification({ message: { id: 1 } })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseIMessageReactionNotification(null)).toBeNull();
    expect(parseIMessageReactionNotification("string")).toBeNull();
    expect(parseIMessageReactionNotification(42)).toBeNull();
  });

  it("returns null when reaction is not an object", () => {
    expect(parseIMessageReactionNotification({ reaction: "invalid" })).toBeNull();
  });

  it("rejects malformed reaction fields", () => {
    expect(
      parseIMessageReactionNotification({
        reaction: { sender: { nested: "nope" } },
      }),
    ).toBeNull();
  });

  it("accepts minimal reaction with all nulls", () => {
    const result = parseIMessageReactionNotification({
      reaction: {
        target_id: null,
        chat_id: null,
        sender: null,
        is_from_me: null,
        reaction_type: null,
        added: null,
        target_text: null,
        created_at: null,
        chat_identifier: null,
        chat_guid: null,
        chat_name: null,
        participants: null,
        is_group: null,
      },
    });
    expect(result).not.toBeNull();
  });

  it("accepts empty reaction object", () => {
    const result = parseIMessageReactionNotification({ reaction: {} });
    expect(result).not.toBeNull();
  });
});
