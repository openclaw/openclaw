/**
 * Unit tests for the Kudosity v2 API client.
 *
 * Mocks `fetchWithSsrFGuard` from the OpenClaw SDK (the pinned-DNS / SSRF-guarded
 * fetch that the production client uses) to test API interactions without
 * hitting the real Kudosity API.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebhook, getSMS, sendSMS, validateApiKey } from "./kudosity-api.js";
import type { KudosityConfig, SMSResponse } from "./kudosity-api.js";

// ─── Mock Setup ──────────────────────────────────────────────────────────────

const mockGuardedFetch = vi.fn();
const mockRelease = vi.fn(async () => {});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => mockGuardedFetch(...args),
}));

/**
 * Helper that packages a fake Response into the `{ response, release }`
 * shape that `fetchWithSsrFGuard` returns.
 */
function mockFetchResult(response: Partial<Response>) {
  return {
    response: response as Response,
    finalUrl: "https://api.transmitmessage.com/mock",
    release: mockRelease,
  };
}

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

beforeEach(() => {
  mockGuardedFetch.mockReset();
  mockRelease.mockClear();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("sendSMS", () => {
  it("should send an SMS with correct parameters", async () => {
    mockGuardedFetch.mockResolvedValueOnce(
      mockFetchResult({
        ok: true,
        json: () => Promise.resolve(MOCK_SMS_RESPONSE),
      }),
    );

    const result = await sendSMS(TEST_CONFIG, {
      message: "Hello from OpenClaw!",
      sender: "+61400000000",
      recipient: "+61478038915",
      message_ref: "openclaw-test-1",
    });

    expect(result.id).toBe("2d2c8fb6-e514-4f5f-9706-0672b0259218");
    expect(result.status).toBe("pending");
    expect(result.message).toBe("Hello from OpenClaw!");

    expect(mockGuardedFetch).toHaveBeenCalledOnce();
    const [options] = mockGuardedFetch.mock.calls[0];
    expect(options.url).toBe("https://api.transmitmessage.com/v2/sms");
    expect(options.init.method).toBe("POST");
    expect(options.init.headers["x-api-key"]).toBe("test-api-key-123");
    expect(options.init.headers["Content-Type"]).toBe("application/json");
    expect(options.auditContext).toBe("kudosity-sms-send");

    const body = JSON.parse(options.init.body);
    expect(body.message).toBe("Hello from OpenClaw!");
    expect(body.sender).toBe("+61400000000");
    expect(body.recipient).toBe("+61478038915");
    expect(body.message_ref).toBe("openclaw-test-1");

    // Pinned dispatcher must always be released after the body is consumed.
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it("should send with track_links enabled", async () => {
    mockGuardedFetch.mockResolvedValueOnce(
      mockFetchResult({
        ok: true,
        json: () => Promise.resolve({ ...MOCK_SMS_RESPONSE, track_links: true }),
      }),
    );

    const result = await sendSMS(TEST_CONFIG, {
      message: "Check this link: https://example.com",
      sender: "+61400000000",
      recipient: "+61478038915",
      track_links: true,
    });

    expect(result.track_links).toBe(true);

    const body = JSON.parse(mockGuardedFetch.mock.calls[0][0].init.body);
    expect(body.track_links).toBe(true);
  });

  it("should throw on API error", async () => {
    mockGuardedFetch.mockResolvedValueOnce(
      mockFetchResult({
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
      }),
    );

    await expect(
      sendSMS(TEST_CONFIG, {
        message: "Hello",
        sender: "+61400000000",
        recipient: "+61478038915",
      }),
    ).rejects.toThrow("Kudosity API error (401): Invalid API key");

    // Release still runs when handleResponse throws.
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it("should handle non-JSON error responses", async () => {
    mockGuardedFetch.mockResolvedValueOnce(
      mockFetchResult({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      }),
    );

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
    mockGuardedFetch.mockResolvedValueOnce(
      mockFetchResult({
        ok: true,
        json: () => Promise.resolve(MOCK_SMS_RESPONSE),
      }),
    );

    const result = await getSMS(TEST_CONFIG, "2d2c8fb6-e514-4f5f-9706-0672b0259218");

    expect(result.id).toBe("2d2c8fb6-e514-4f5f-9706-0672b0259218");

    const [options] = mockGuardedFetch.mock.calls[0];
    expect(options.url).toBe(
      "https://api.transmitmessage.com/v2/sms/2d2c8fb6-e514-4f5f-9706-0672b0259218",
    );
    expect(options.init.method).toBe("GET");
    expect(options.init.headers["x-api-key"]).toBe("test-api-key-123");
    expect(options.auditContext).toBe("kudosity-sms-get");
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

    mockGuardedFetch.mockResolvedValueOnce(
      mockFetchResult({
        ok: true,
        json: () => Promise.resolve(mockWebhookResponse),
      }),
    );

    const result = await createWebhook(TEST_CONFIG, {
      url: "https://my-openclaw.com/api/channels/kudosity-sms/webhook",
      event_type: "SMS_INBOUND",
    });

    expect(result.id).toBe("wh-123");
    expect(result.event_type).toBe("SMS_INBOUND");

    const [options] = mockGuardedFetch.mock.calls[0];
    expect(options.url).toBe("https://api.transmitmessage.com/v2/webhook");
    expect(options.init.method).toBe("POST");
    expect(options.auditContext).toBe("kudosity-sms-webhook-create");
  });
});

describe("validateApiKey", () => {
  it("should return true for a valid API key", async () => {
    mockGuardedFetch.mockResolvedValueOnce(mockFetchResult({ ok: true }));

    const result = await validateApiKey(TEST_CONFIG);
    expect(result).toBe(true);
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it("should return false for an invalid API key", async () => {
    mockGuardedFetch.mockResolvedValueOnce(mockFetchResult({ ok: false }));

    const result = await validateApiKey(TEST_CONFIG);
    expect(result).toBe(false);
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it("should return false on network error", async () => {
    mockGuardedFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await validateApiKey(TEST_CONFIG);
    expect(result).toBe(false);
    // Release is not called when the fetch itself throws (no result was returned).
    expect(mockRelease).not.toHaveBeenCalled();
  });
});
