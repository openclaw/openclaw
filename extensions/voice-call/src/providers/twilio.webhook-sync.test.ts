import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwilioProvider } from "./twilio.js";

function okResponse(body?: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

function errorResponse(status: number, text: string): Response {
  return {
    ok: false,
    status,
    text: async () => text,
  } as unknown as Response;
}

describe("TwilioProvider.syncIncomingNumberVoiceWebhook", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("updates IncomingPhoneNumbers by SID", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(okResponse());

    const provider = new TwilioProvider({ accountSid: "AC123", authToken: "secret" });

    const result = await provider.syncIncomingNumberVoiceWebhook({
      webhookUrl: "https://example.ngrok.app/voice/webhook",
      incomingPhoneNumberSid: "PN123",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetSid).toBe("PN123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/IncomingPhoneNumbers/PN123.json");
    expect((init as RequestInit).method).toBe("POST");

    const body = (init as RequestInit).body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(body.get("VoiceUrl")).toBe("https://example.ngrok.app/voice/webhook");
    expect(body.get("VoiceMethod")).toBe("POST");
  });

  it("looks up IncomingPhoneNumbers by phone number and then updates by SID", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          incoming_phone_numbers: [{ sid: "PN999", phone_number: "+15550001234" }],
        }),
      )
      .mockResolvedValueOnce(okResponse());

    const provider = new TwilioProvider({ accountSid: "AC123", authToken: "secret" });

    const result = await provider.syncIncomingNumberVoiceWebhook({
      webhookUrl: "https://example.ngrok.app/voice/webhook",
      incomingPhoneNumber: "+15550001234",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetSid).toBe("PN999");

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0]!;
    expect(String(lookupUrl)).toContain("/IncomingPhoneNumbers.json?");
    expect(String(lookupUrl)).toContain("PhoneNumber=%2B15550001234");
    expect(String(lookupUrl)).toContain("PageSize=20");
    expect((lookupInit as RequestInit).method).toBe("GET");

    const [updateUrl, updateInit] = fetchMock.mock.calls[1]!;
    expect(String(updateUrl)).toContain("/IncomingPhoneNumbers/PN999.json");
    expect((updateInit as RequestInit).method).toBe("POST");
  });

  it("fails on multiple matches unless allowMultipleMatches is true", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(
      okResponse({
        incoming_phone_numbers: [{ sid: "PN1" }, { sid: "PN2" }],
      }),
    );

    const provider = new TwilioProvider({ accountSid: "AC123", authToken: "secret" });

    const result = await provider.syncIncomingNumberVoiceWebhook({
      webhookUrl: "https://example.ngrok.app/voice/webhook",
      incomingPhoneNumber: "+15550001234",
      allowMultipleMatches: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Multiple incoming phone numbers matched");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a helpful failure when identifiers are missing", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(okResponse());

    const provider = new TwilioProvider({ accountSid: "AC123", authToken: "secret" });
    const result = await provider.syncIncomingNumberVoiceWebhook({
      webhookUrl: "https://example.ngrok.app/voice/webhook",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Missing Twilio incoming phone number identifier");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("returns lookup failure details", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));

    const provider = new TwilioProvider({ accountSid: "AC123", authToken: "secret" });
    const result = await provider.syncIncomingNumberVoiceWebhook({
      webhookUrl: "https://example.ngrok.app/voice/webhook",
      incomingPhoneNumber: "+15550001234",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Twilio lookup failed");
    expect(result.reason).toContain("401");
  });
});
