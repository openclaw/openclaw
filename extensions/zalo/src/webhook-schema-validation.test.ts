import { describe, expect, it } from "vitest";
import { validateZaloWebhookPayload } from "./webhook-schema-validation.js";

describe("Zalo webhook schema validation", () => {
  it("accepts valid message.text.received payload", () => {
    const payload = {
      event_name: "message.text.received",
      message: {
        from: { id: "123456" },
        chat: { id: "789", chat_type: "INDIVIDUAL" },
        message_id: "msg-1",
        text: "Hello",
      },
    };

    const result = validateZaloWebhookPayload(payload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.event_name).toBe("message.text.received");
      expect(result.data.message?.text).toBe("Hello");
    }
  });

  it("accepts valid message.image.received payload", () => {
    const payload = {
      event_name: "message.image.received",
      message: {
        from: { id: "123456", name: "John" },
        chat: { id: "789", chat_type: "GROUP" },
        message_id: "msg-2",
        photo: "https://example.com/image.jpg",
        caption: "Check this out",
        date: 1234567890,
      },
    };

    const result = validateZaloWebhookPayload(payload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.event_name).toBe("message.image.received");
      expect(result.data.message?.photo).toBe("https://example.com/image.jpg");
    }
  });

  it("rejects null payload", () => {
    const result = validateZaloWebhookPayload(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("must be a JSON object");
    }
  });

  it("rejects array payload", () => {
    const result = validateZaloWebhookPayload([]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("must be a JSON object");
    }
  });

  it("rejects string payload", () => {
    const result = validateZaloWebhookPayload("not an object");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("must be a JSON object");
    }
  });

  it("rejects payload missing event_name", () => {
    const payload = {
      message: {
        from: { id: "123456" },
        chat: { id: "789", chat_type: "INDIVIDUAL" },
        message_id: "msg-1",
      },
    };

    const result = validateZaloWebhookPayload(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Invalid payload structure");
    }
  });

  it("rejects payload with invalid event_name", () => {
    const payload = {
      event_name: "invalid.event",
      message: {
        from: { id: "123456" },
        chat: { id: "789", chat_type: "INDIVIDUAL" },
        message_id: "msg-1",
      },
    };

    const result = validateZaloWebhookPayload(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Invalid payload structure");
    }
  });

  it("rejects payload with missing message fields", () => {
    const payload = {
      event_name: "message.text.received",
      message: {
        from: { id: "123456" },
        // missing chat
        message_id: "msg-1",
      },
    };

    const result = validateZaloWebhookPayload(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Invalid payload structure");
    }
  });

  it("rejects payload with invalid chat_type", () => {
    const payload = {
      event_name: "message.text.received",
      message: {
        from: { id: "123456" },
        chat: { id: "789", chat_type: "INVALID_TYPE" },
        message_id: "msg-1",
        text: "Hello",
      },
    };

    const result = validateZaloWebhookPayload(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Invalid payload structure");
    }
  });

  it("accepts payload with extra fields (additional properties)", () => {
    const payload = {
      event_name: "message.text.received",
      message: {
        from: { id: "123456" },
        chat: { id: "789", chat_type: "INDIVIDUAL" },
        message_id: "msg-1",
        text: "Hello",
      },
      extra_field: "should be ignored",
      nested_extra: { deep: "value" },
    };

    const result = validateZaloWebhookPayload(payload);
    expect(result.valid).toBe(true);
  });

  it("rejects payload with malformed sender ID", () => {
    const payload = {
      event_name: "message.text.received",
      message: {
        from: { id: 123 }, // should be string
        chat: { id: "789", chat_type: "INDIVIDUAL" },
        message_id: "msg-1",
      },
    };

    const result = validateZaloWebhookPayload(payload);
    expect(result.valid).toBe(false);
  });

  it("accepts sticker received event", () => {
    const payload = {
      event_name: "message.sticker.received",
      message: {
        from: { id: "123456" },
        chat: { id: "789", chat_type: "GROUP" },
        message_id: "msg-3",
      },
    };

    const result = validateZaloWebhookPayload(payload);
    expect(result.valid).toBe(true);
  });

  it("rejects undefined payload", () => {
    const result = validateZaloWebhookPayload(undefined);
    expect(result.valid).toBe(false);
  });

  it("rejects numeric payload", () => {
    const result = validateZaloWebhookPayload(42);
    expect(result.valid).toBe(false);
  });

  it("rejects boolean payload", () => {
    const result = validateZaloWebhookPayload(false);
    expect(result.valid).toBe(false);
  });
});
