/**
 * Unit tests for the Kudosity v2 API client.
 *
 * Mocks the global fetch to test API interactions without hitting
 * the real Kudosity API.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { sendSMS, getSMS, validateApiKey, createWebhook } from "./kudosity-api.js";
import type { KudosityConfig, SMSResponse } from "./kudosity-api.js";

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const TEST_CONFIG: KudosityConfig = {
  apiKey: "test-api-key-123", // pragma: allowlist secret
  sender: "+61400000000",
};

const MOCK_SMS_RESPONSE: SMSResponse = {
  id: "2d2c8fb6-e514-4f5f-9706-0672b0259218",
  recipient: "61478038915",
  recipient_country: "AU",
  sender: "61400000000",
  sender_country: "AU",
  message_ref: "openclaw-test-1",
  message: "Hello from OpenClaw!",
  status: "pending",
  sms_count: "1",
  is_gsm: true,
  routed_via: "",
  track_links: false,
  direction: "OUT",
  created_at: "2026-03-02T06:12:52.450674000Z",
  updated_at: "2026-03-02T06:12:52.450674000Z",
};

// ─── Mock Setup ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("sendSMS", () => {
  it("should send an SMS with correct parameters", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_SMS_RESPONSE),
    });

    const result = await sendSMS(TEST_CONFIG, {
      message: "Hello from OpenClaw!",
      sender: "+61400000000",
      recipient: "+61478038915",
      message_ref: "openclaw-test-1",
    });

    expect(result.id).toBe("2d2c8fb6-e514-4f5f-9706-0672b0259218");
    expect(result.status).toBe("pending");
    expect(result.message).toBe("Hello from OpenClaw!");

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.transmitmessage.com/v2/sms");
    expect(options.method).toBe("POST");
    expect(options.headers["x-api-key"]).toBe("test-api-key-123");
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.message).toBe("Hello from OpenClaw!");
    expect(body.sender).toBe("+61400000000");
    expect(body.recipient).toBe("+61478038915");
    expect(body.message_ref).toBe("openclaw-test-1");
  });

  it("should send with track_links enabled", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...MOCK_SMS_RESPONSE, track_links: true }),
    });

    const result = await sendSMS(TEST_CONFIG, {
      message: "Check this link: https://example.com",
      sender: "+61400000000",
      recipient: "+61478038915",
      track_links: true,
    });

    expect(result.track_links).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.track_links).toBe(true);
  });

  it("should throw on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            error: "Unauthorized",
            message: "Invalid API key",
            status_code: 401,
          }),
        ),
    });

    await expect(
      sendSMS(TEST_CONFIG, {
        message: "Hello",
        sender: "+61400000000",
        recipient: "+61478038915",
      }),
    ).rejects.toThrow("Kudosity API error (401): Invalid API key");
  });

  it("should handle non-JSON error responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(
      sendSMS(TEST_CONFIG, {
        message: "Hello",
        sender: "+61400000000",
        recipient: "+61478038915",
      }),
    ).rejects.toThrow("Kudosity API error (500): Internal Server Error");
  });
});

describe("getSMS", () => {
  it("should retrieve SMS details by ID", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_SMS_RESPONSE),
    });

    const result = await getSMS(TEST_CONFIG, "2d2c8fb6-e514-4f5f-9706-0672b0259218");

    expect(result.id).toBe("2d2c8fb6-e514-4f5f-9706-0672b0259218");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.transmitmessage.com/v2/sms/2d2c8fb6-e514-4f5f-9706-0672b0259218");
    expect(options.method).toBe("GET");
    expect(options.headers["x-api-key"]).toBe("test-api-key-123");
  });
});

describe("createWebhook", () => {
  it("should create a webhook subscription", async () => {
    const mockWebhookResponse = {
      id: "wh-123",
      url: "https://my-openclaw.com/api/channels/kudosity-sms/webhook",
      event_type: "SMS_INBOUND",
      created_at: "2026-03-02T06:12:52Z",
      updated_at: "2026-03-02T06:12:52Z",
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockWebhookResponse),
    });

    const result = await createWebhook(TEST_CONFIG, {
      url: "https://my-openclaw.com/api/channels/kudosity-sms/webhook",
      event_type: "SMS_INBOUND",
    });

    expect(result.id).toBe("wh-123");
    expect(result.event_type).toBe("SMS_INBOUND");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.transmitmessage.com/v2/webhook");
    expect(options.method).toBe("POST");
  });
});

describe("validateApiKey", () => {
  it("should return true for a valid API key", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await validateApiKey(TEST_CONFIG);
    expect(result).toBe(true);
  });

  it("should return false for an invalid API key", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    const result = await validateApiKey(TEST_CONFIG);
    expect(result).toBe(false);
  });

  it("should return false on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await validateApiKey(TEST_CONFIG);
    expect(result).toBe(false);
  });
});
