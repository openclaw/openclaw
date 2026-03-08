import { describe, expect, it } from "vitest";
import { parseRichContent, payloadToInboundMessage } from "./monitor.js";
import type { NextcloudTalkWebhookPayload } from "./types.js";

/** Helper to build a minimal valid webhook payload. */
function makePayload(
  overrides: Partial<NextcloudTalkWebhookPayload["object"]> = {},
): NextcloudTalkWebhookPayload {
  return {
    type: "Create",
    actor: { type: "Person", id: "users/alice", name: "Alice" },
    object: {
      type: "Note",
      id: "100",
      name: "message",
      content: "",
      mediaType: "text/markdown",
      ...overrides,
    },
    target: { type: "Collection", id: "room123", name: "TestRoom" },
  };
}

describe("parseRichContent", () => {
  it("parses valid rich content JSON", () => {
    const input = JSON.stringify({ message: "Hello", parameters: {} });
    const result = parseRichContent(input);
    expect(result).toEqual({ message: "Hello", parameters: {} });
  });

  it("returns null for non-JSON string", () => {
    expect(parseRichContent("plain text")).toBeNull();
  });

  it("returns null for JSON without message field", () => {
    expect(parseRichContent(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRichContent("")).toBeNull();
  });
});

describe("payloadToInboundMessage — rich content", () => {
  it("handles normal text message (no change in behavior)", () => {
    const payload = makePayload({
      content: JSON.stringify({ message: "Hello world", parameters: {} }),
    });
    const msg = payloadToInboundMessage(payload);
    expect(msg.text).toBe("Hello world");
    expect(msg.fileParameters).toBeUndefined();
  });

  it("handles file share message (single file)", () => {
    const payload = makePayload({
      name: "",
      content: JSON.stringify({
        message: "{file}",
        parameters: {
          file: {
            type: "file",
            id: "117924",
            name: "IMG_1772227153579.jpg",
            size: 3145728,
            path: "Talk/IMG_1772227153579.jpg",
            link: "https://cloud.example.com/f/117924",
            mimetype: "image/jpeg",
            "preview-available": "yes",
          },
        },
      }),
    });
    const msg = payloadToInboundMessage(payload);
    expect(msg.text).toBe("IMG_1772227153579.jpg");
    expect(msg.fileParameters).toHaveLength(1);
    expect(msg.fileParameters![0].name).toBe("IMG_1772227153579.jpg");
    expect(msg.fileParameters![0].mimetype).toBe("image/jpeg");
    expect(msg.fileParameters![0].path).toBe("Talk/IMG_1772227153579.jpg");
  });

  it("handles image share message (mimetype image/*)", () => {
    const payload = makePayload({
      name: "",
      content: JSON.stringify({
        message: "{file}",
        parameters: {
          file: {
            type: "file",
            id: "200",
            name: "screenshot.png",
            size: 500000,
            path: "Talk/screenshot.png",
            link: "https://cloud.example.com/f/200",
            mimetype: "image/png",
            "preview-available": "yes",
          },
        },
      }),
    });
    const msg = payloadToInboundMessage(payload);
    expect(msg.text).toBe("screenshot.png");
    expect(msg.fileParameters).toHaveLength(1);
    expect(msg.fileParameters![0].mimetype).toBe("image/png");
  });

  it("handles message with text AND file attachment", () => {
    const payload = makePayload({
      content: JSON.stringify({
        message: "Check this out {file}",
        parameters: {
          file: {
            type: "file",
            id: "117925",
            name: "document.pdf",
            size: 524288,
            path: "Talk/document.pdf",
            link: "https://cloud.example.com/f/117925",
            mimetype: "application/pdf",
            "preview-available": "no",
          },
        },
      }),
    });
    const msg = payloadToInboundMessage(payload);
    expect(msg.text).toBe("Check this out document.pdf");
    expect(msg.fileParameters).toHaveLength(1);
    expect(msg.fileParameters![0].name).toBe("document.pdf");
  });

  it("gracefully falls back to raw content on malformed JSON", () => {
    const payload = makePayload({
      content: "this is not json at all",
      name: "fallback-name",
    });
    const msg = payloadToInboundMessage(payload);
    // Fallback: raw content is used (not name, since content is non-empty)
    expect(msg.text).toBe("this is not json at all");
    expect(msg.fileParameters).toBeUndefined();
  });

  it("falls back to object.name when content is empty and not parseable", () => {
    const payload = makePayload({
      content: "",
      name: "fallback-name",
    });
    const msg = payloadToInboundMessage(payload);
    expect(msg.text).toBe("fallback-name");
    expect(msg.fileParameters).toBeUndefined();
  });

  it("handles multiple file parameters", () => {
    const payload = makePayload({
      content: JSON.stringify({
        message: "{file0} and {file1}",
        parameters: {
          file0: {
            type: "file",
            id: "301",
            name: "photo1.jpg",
            size: 1000,
            path: "Talk/photo1.jpg",
            link: "https://cloud.example.com/f/301",
            mimetype: "image/jpeg",
            "preview-available": "yes",
          },
          file1: {
            type: "file",
            id: "302",
            name: "photo2.jpg",
            size: 2000,
            path: "Talk/photo2.jpg",
            link: "https://cloud.example.com/f/302",
            mimetype: "image/jpeg",
            "preview-available": "yes",
          },
        },
      }),
    });
    const msg = payloadToInboundMessage(payload);
    expect(msg.text).toBe("photo1.jpg and photo2.jpg");
    expect(msg.fileParameters).toHaveLength(2);
    expect(msg.fileParameters!.map((f) => f.name).sort()).toEqual(["photo1.jpg", "photo2.jpg"]);
  });

  it("handles empty parameters object (treated as normal text)", () => {
    const payload = makePayload({
      content: JSON.stringify({
        message: "Just a normal message",
        parameters: {},
      }),
    });
    const msg = payloadToInboundMessage(payload);
    expect(msg.text).toBe("Just a normal message");
    expect(msg.fileParameters).toBeUndefined();
  });

  it("ignores non-file parameter types", () => {
    const payload = makePayload({
      content: JSON.stringify({
        message: "Hello {mention-user1}",
        parameters: {
          "mention-user1": {
            type: "user",
            id: "alice",
            name: "Alice",
          },
        },
      }),
    });
    const msg = payloadToInboundMessage(payload);
    // {mention-user1} contains a hyphen, resolved via [\w-]+ regex
    expect(msg.text).toBe("Hello Alice");
    // Non-file parameter types should not appear in fileParameters
    expect(msg.fileParameters).toBeUndefined();
  });

  it("preserves standard message fields", () => {
    const payload = makePayload({
      content: JSON.stringify({ message: "test", parameters: {} }),
    });
    const msg = payloadToInboundMessage(payload);
    expect(msg.messageId).toBe("100");
    expect(msg.roomToken).toBe("room123");
    expect(msg.roomName).toBe("TestRoom");
    expect(msg.senderId).toBe("users/alice");
    expect(msg.senderName).toBe("Alice");
    expect(msg.mediaType).toBe("text/markdown");
    expect(msg.isGroupChat).toBe(true);
  });
});
