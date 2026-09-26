// Imessage test support covers parse notification plugin behavior.
import { describe, expect, it } from "vitest";
import { parseIMessageNotification } from "./parse-notification.js";

describe("parseIMessageNotification", () => {
  it("strips a length-delimited field wrapper from text and reply_to_text", () => {
    const wrappedText = `${String.fromCharCode(0x0a, 11)}hello world`;
    const wrappedReply = `${String.fromCharCode(0x0a, 5)}quote`;
    const raw = { message: { text: wrappedText, reply_to_text: wrappedReply } };

    const parsed = parseIMessageNotification(raw);
    expect(parsed?.text).toBe("hello world");
    expect(parsed?.reply_to_text).toBe("quote");
  });

  it("preserves reaction event metadata", () => {
    const parsed = parseIMessageNotification({
      message: {
        is_reaction: true,
        is_tapback: true,
        associated_message_guid: "p:0/target-guid",
        associated_message_type: 2001,
        reaction_type: "like",
        reaction_emoji: "👍",
        is_reaction_add: true,
        reacted_to_guid: "target-guid",
      },
    });

    expect(parsed?.is_reaction).toBe(true);
    expect(parsed?.is_tapback).toBe(true);
    expect(parsed?.associated_message_guid).toBe("p:0/target-guid");
    expect(parsed?.associated_message_type).toBe(2001);
    expect(parsed?.reaction_emoji).toBe("👍");
    expect(parsed?.reacted_to_guid).toBe("target-guid");
  });

  it("preserves the provider's thread-originator and direct-reply GUIDs", () => {
    const parsed = parseIMessageNotification({
      message: {
        guid: "message-guid",
        thread_originator_guid: "thread-parent",
        reply_to_guid: "reply-parent",
        reply_to_text: "parent question",
        reply_to_sender: "+10000000000",
      },
    });

    expect(parsed).toMatchObject({
      thread_originator_guid: "thread-parent",
      reply_to_guid: "reply-parent",
      reply_to_text: "parent question",
      reply_to_sender: "+10000000000",
    });
  });

  it("preserves the provider-resolved sender contact name", () => {
    const parsed = parseIMessageNotification({
      message: {
        sender: "+15551234567",
        sender_name: "Alice",
      },
    });

    expect(parsed?.sender_name).toBe("Alice");
  });

  it("rejects malformed sender contact names", () => {
    expect(parseIMessageNotification({ message: { sender_name: 42 } })).toBeNull();
  });

  it("rejects malformed provider thread-originator GUIDs", () => {
    expect(parseIMessageNotification({ message: { thread_originator_guid: 42 } })).toBeNull();
  });

  it("accepts iMessage attachment transfer_name and uti metadata", () => {
    const parsed = parseIMessageNotification({
      message: {
        attachments: [
          {
            original_path:
              "/Users/openclaw/Library/Messages/Attachments/AA/BB/link.pluginPayloadAttachment",
            mime_type: null,
            missing: false,
            transfer_name: "link.pluginPayloadAttachment",
            uti: "com.apple.messages.pluginPayloadAttachment",
          },
        ],
      },
    });

    expect(parsed?.attachments?.[0]).toMatchObject({
      transfer_name: "link.pluginPayloadAttachment",
      uti: "com.apple.messages.pluginPayloadAttachment",
    });
  });
});
