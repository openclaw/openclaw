import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../../../test-support/streaming-error-response.js";

type GuardedRequest = Parameters<typeof import("../../../api.js").fetchWithSsrFGuard>[0];
type GuardedResponse = { response: Response; release: () => Promise<void> };
const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn<(request: GuardedRequest) => Promise<GuardedResponse>>(),
}));

// mock-isolation: Inject the HTTP guard without loading the plugin-entry and TTS runtime barrel.
vi.mock("../../../api.js", () => ({ fetchWithSsrFGuard: fetchWithSsrFGuardMock }));

import { resolveTwilioApiBaseUrl } from "../twilio-region.js";
import { TwilioApiError, createTwilioApi } from "./api.js";

async function twilioApiRequest({
  baseUrl = resolveTwilioApiBaseUrl({ accountSid: "AC123" }),
  endpoint = "/Calls.json",
  body = {},
  allowNotFound,
}: {
  baseUrl?: string;
  endpoint?: string;
  body?: URLSearchParams | Record<string, string | string[]>;
  allowNotFound?: boolean;
} = {}) {
  const api = createTwilioApi({ baseUrl, accountSid: "AC123", authToken: "secret" });
  return api.request(endpoint, body, { allowNotFound });
}

const release = vi.fn(async () => {});
function mockResponse(response = new Response(JSON.stringify({ sid: "CA123" }))) {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
}

describe("twilioApiRequest", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    release.mockClear();
  });

  it("posts form bodies with basic auth and parses json", async () => {
    mockResponse();
    const body = { To: "+14155550123", StatusCallbackEvent: ["initiated", "completed"] };
    await expect(twilioApiRequest({ body })).resolves.toEqual({ sid: "CA123" });

    const [request] = fetchWithSsrFGuardMock.mock.calls[0]!;
    expect(request).toMatchObject({
      url: "https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json",
      auditContext: "voice-call.twilio.api",
      timeoutMs: 30_000,
      init: { method: "POST" },
    });
    expect(request.policy).toEqual({ allowedHostnames: ["api.twilio.com"] });
    expect(request.init?.headers).toEqual({
      Authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const requestBody = request.init?.body;
    assert(requestBody instanceof URLSearchParams, "expected URLSearchParams request body");
    expect(requestBody.toString()).toBe(
      "To=%2B14155550123&StatusCallbackEvent=initiated&StatusCallbackEvent=completed",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("derives the regional hostname for the request and SSRF policy", async () => {
    mockResponse();
    const baseUrl = resolveTwilioApiBaseUrl({ accountSid: "AC123", region: "ie1" });
    await twilioApiRequest({ baseUrl });

    const [{ url, policy }] = fetchWithSsrFGuardMock.mock.calls[0]!;
    expect(url).toBe("https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    expect(policy).toEqual({ allowedHostnames: ["api.dublin.ie1.twilio.com"] });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported API hosts before the SSRF guard", async () => {
    await expect(
      twilioApiRequest({
        baseUrl: "https://metadata.google.internal/2010-04-01/Accounts/AC123",
      }),
    ).rejects.toThrow("Unsupported Twilio API hostname: metadata.google.internal");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("passes through URLSearchParams, allows 404s, and returns undefined for empty bodies", async () => {
    const missing = cancelTrackedTextResponse("missing", { status: 404 });
    mockResponse(new Response("", { status: 200 }));
    mockResponse(missing.response);
    await expect(
      twilioApiRequest({ body: new URLSearchParams({ To: "+14155550123" }) }),
    ).resolves.toBeUndefined();

    await expect(
      twilioApiRequest({ endpoint: "/Calls/missing.json", allowNotFound: true }),
    ).resolves.toBeUndefined();
    expect(missing.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("bounds twilio error bodies and cancels unread overflow", async () => {
    const tracked = cancelTrackedTextResponse("x".repeat(9 * 1024), { status: 400 });
    mockResponse(tracked.response);
    const error: unknown = await twilioApiRequest().catch((cause: unknown) => cause);
    assert(error instanceof TwilioApiError, "expected Twilio API error");
    expect(error.message).toContain("Twilio API error: 400 ");
    expect(error.message).toContain("... [truncated]");
    expect(error.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("wraps malformed json success responses with an owned error", async () => {
    mockResponse(new Response("{not json"));
    await expect(twilioApiRequest()).rejects.toThrow("Twilio API returned malformed JSON.");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("exposes structured Twilio error codes from json error bodies", async () => {
    const message = "Call is not in-progress. Cannot redirect.";
    const moreInfo = "https://www.twilio.com/docs/errors/21220";
    mockResponse(
      new Response(JSON.stringify({ code: 21220, message, more_info: moreInfo, status: 400 }), {
        status: 400,
      }),
    );
    const request = twilioApiRequest({ endpoint: "/Calls/CA123.json" });
    await expect(request).rejects.toBeInstanceOf(TwilioApiError);
    await expect(request).rejects.toMatchObject({
      name: "TwilioApiError",
      twilioCode: 21220,
      moreInfo,
      message: `Twilio API error: 400 Call is not in-progress. Cannot redirect. (Twilio error 21220: ${moreInfo})`,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps the Twilio code in the message when the docs link is missing or not https", async () => {
    const message = "Account not allowed to call +15550100";
    mockResponse(
      new Response(JSON.stringify({ code: 21216, message, more_info: "javascript:alert(1)" }), {
        status: 400,
      }),
    );
    const error: unknown = await twilioApiRequest().catch((cause: unknown) => cause);
    assert(error instanceof TwilioApiError, "expected Twilio API error");
    expect(error.twilioCode).toBe(21216);
    expect(error.moreInfo).toBeUndefined();
    expect(error.message).toBe(
      "Twilio API error: 400 Account not allowed to call +15550100 (Twilio error 21216)",
    );
  });
});
