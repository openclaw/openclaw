/**
 * Unit tests for the Kudosity SMS webhook handler.
 *
 * Tests parsing, validation, and routing of inbound webhook payloads
 * from the Kudosity API.
 */

import { describe, expect, it } from "vitest";
import {
  parseWebhookPayload,
  isInboundSMS,
  isOptOut,
  isSMSStatus,
  toInboundMessage,
  handleWebhookRequest,
} from "./webhook.js";

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const INBOUND_SMS_PAYLOAD = {
  event_type: "SMS_INBOUND",
  timestamp: "2026-03-02T06:12:52Z",
  data: {
    id: "msg-inbound-123",
    sender: "+61478038915",
    recipient: "+61400000000",
    message: "Hello AI assistant!",
    created_at: "2026-03-02T06:12:52Z",
  },
};

const SMS_STATUS_PAYLOAD = {
  event_type: "SMS_STATUS",
  timestamp: "2026-03-02T06:13:00Z",
  data: {
    id: "msg-outbound-456",
    status: "delivered",
    recipient: "+61478038915",
  },
};

const OPT_OUT_PAYLOAD = {
  event_type: "OPT_OUT",
  timestamp: "2026-03-02T06:14:00Z",
  data: {
    id: "msg-optout-789",
    sender: "+61478038915",
    recipient: "+61400000000",
    message: "STOP",
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("parseWebhookPayload", () => {
  it("should parse a valid inbound SMS payload", () => {
    const result = parseWebhookPayload(INBOUND_SMS_PAYLOAD);
    expect(result).not.toBeNull();
    expect(result!.event_type).toBe("SMS_INBOUND");
  });

  it("should parse a valid SMS status payload", () => {
    const result = parseWebhookPayload(SMS_STATUS_PAYLOAD);
    expect(result).not.toBeNull();
    expect(result!.event_type).toBe("SMS_STATUS");
  });

  it("should return null for null input", () => {
    expect(parseWebhookPayload(null)).toBeNull();
  });

  it("should return null for undefined input", () => {
    expect(parseWebhookPayload(undefined)).toBeNull();
  });

  it("should return null for non-object input", () => {
    expect(parseWebhookPayload("string")).toBeNull();
    expect(parseWebhookPayload(42)).toBeNull();
    expect(parseWebhookPayload(true)).toBeNull();
  });

  it("should return null if event_type is missing", () => {
    expect(parseWebhookPayload({ data: {} })).toBeNull();
  });

  it("should return null if event_type is not a string", () => {
    expect(parseWebhookPayload({ event_type: 123, data: {} })).toBeNull();
  });

  it("should return null if data is missing", () => {
    expect(parseWebhookPayload({ event_type: "SMS_INBOUND" })).toBeNull();
  });

  it("should return null if data is not an object", () => {
    expect(parseWebhookPayload({ event_type: "SMS_INBOUND", data: "string" })).toBeNull();
  });
});

describe("event type checks", () => {
  it("isInboundSMS should identify inbound SMS events", () => {
    const payload = parseWebhookPayload(INBOUND_SMS_PAYLOAD)!;
    expect(isInboundSMS(payload)).toBe(true);
    expect(isOptOut(payload)).toBe(false);
    expect(isSMSStatus(payload)).toBe(false);
  });

  it("isOptOut should identify opt-out events", () => {
    const payload = parseWebhookPayload(OPT_OUT_PAYLOAD)!;
    expect(isOptOut(payload)).toBe(true);
    expect(isInboundSMS(payload)).toBe(false);
    expect(isSMSStatus(payload)).toBe(false);
  });

  it("isSMSStatus should identify status events", () => {
    const payload = parseWebhookPayload(SMS_STATUS_PAYLOAD)!;
    expect(isSMSStatus(payload)).toBe(true);
    expect(isInboundSMS(payload)).toBe(false);
    expect(isOptOut(payload)).toBe(false);
  });
});

describe("toInboundMessage", () => {
  it("should convert an inbound SMS payload to an InboundMessage", () => {
    const payload = parseWebhookPayload(INBOUND_SMS_PAYLOAD)!;
    const message = toInboundMessage(payload);

    expect(message).not.toBeNull();
    expect(message!.channel).toBe("kudosity-sms");
    expect(message!.from).toBe("+61478038915");
    expect(message!.to).toBe("+61400000000");
    expect(message!.text).toBe("Hello AI assistant!");
    expect(message!.messageId).toBe("msg-inbound-123");
    expect(message!.timestamp).toBe("2026-03-02T06:12:52Z");
  });

  it("should return null for non-inbound events", () => {
    const payload = parseWebhookPayload(SMS_STATUS_PAYLOAD)!;
    expect(toInboundMessage(payload)).toBeNull();
  });

  it("should return null if data is missing required fields", () => {
    const payload = parseWebhookPayload({
      event_type: "SMS_INBOUND",
      timestamp: "2026-03-02T06:12:52Z",
      data: {
        id: "msg-123",
        sender: "+61478038915",
        // missing recipient and message
      },
    })!;
    expect(toInboundMessage(payload)).toBeNull();
  });

  it("should use payload timestamp as fallback", () => {
    const payload = parseWebhookPayload({
      event_type: "SMS_INBOUND",
      timestamp: "2026-03-02T07:00:00Z",
      data: {
        id: "msg-123",
        sender: "+61478038915",
        recipient: "+61400000000",
        message: "Hi",
        // no created_at
      },
    })!;
    const message = toInboundMessage(payload);
    expect(message!.timestamp).toBe("2026-03-02T07:00:00Z");
  });

  it("should return null for whitespace-only sender", () => {
    const payload = parseWebhookPayload({
      event_type: "SMS_INBOUND",
      timestamp: "2026-03-02T06:12:52Z",
      data: {
        id: "msg-123",
        sender: "   ",
        recipient: "+61400000000",
        message: "Hello",
        created_at: "2026-03-02T06:12:52Z",
      },
    })!;
    expect(toInboundMessage(payload)).toBeNull();
  });

  it("should return null for whitespace-only message", () => {
    const payload = parseWebhookPayload({
      event_type: "SMS_INBOUND",
      timestamp: "2026-03-02T06:12:52Z",
      data: {
        id: "msg-123",
        sender: "+61478038915",
        recipient: "+61400000000",
        message: "   ",
        created_at: "2026-03-02T06:12:52Z",
      },
    })!;
    expect(toInboundMessage(payload)).toBeNull();
  });

  it("should return null for whitespace-only id", () => {
    const payload = parseWebhookPayload({
      event_type: "SMS_INBOUND",
      timestamp: "2026-03-02T06:12:52Z",
      data: {
        id: "   ",
        sender: "+61478038915",
        recipient: "+61400000000",
        message: "Hello",
        created_at: "2026-03-02T06:12:52Z",
      },
    })!;
    expect(toInboundMessage(payload)).toBeNull();
  });

  it("should return null if data.id is missing", () => {
    const payload = parseWebhookPayload({
      event_type: "SMS_INBOUND",
      timestamp: "2026-03-02T06:12:52Z",
      data: {
        sender: "+61478038915",
        recipient: "+61400000000",
        message: "Hello",
        created_at: "2026-03-02T06:12:52Z",
        // missing id
      },
    })!;
    expect(toInboundMessage(payload)).toBeNull();
  });

  it("should return null if both created_at and payload timestamp are missing", () => {
    const payload = parseWebhookPayload({
      event_type: "SMS_INBOUND",
      data: {
        id: "msg-123",
        sender: "+61478038915",
        recipient: "+61400000000",
        message: "Hello",
        // no created_at
      },
      // no timestamp
    })!;
    expect(toInboundMessage(payload)).toBeNull();
  });
});

describe("handleWebhookRequest", () => {
  it("should process a valid inbound SMS request", () => {
    const message = handleWebhookRequest(INBOUND_SMS_PAYLOAD);
    expect(message).not.toBeNull();
    expect(message!.channel).toBe("kudosity-sms");
    expect(message!.text).toBe("Hello AI assistant!");
  });

  it("should return null for status events", () => {
    expect(handleWebhookRequest(SMS_STATUS_PAYLOAD)).toBeNull();
  });

  it("should return null for opt-out events", () => {
    expect(handleWebhookRequest(OPT_OUT_PAYLOAD)).toBeNull();
  });

  it("should return null for invalid payloads", () => {
    expect(handleWebhookRequest(null)).toBeNull();
    expect(handleWebhookRequest({})).toBeNull();
    expect(handleWebhookRequest("invalid")).toBeNull();
  });
});
