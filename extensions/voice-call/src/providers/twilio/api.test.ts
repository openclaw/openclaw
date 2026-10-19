import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../../../test-support/streaming-error-response.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<
      (
        request: Parameters<typeof import("../../../api.js").fetchWithSsrFGuard>[0],
      ) => Promise<{ response: Response; release: () => Promise<void> }>
    >(),
}));

vi.mock("../../../api.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { resolveTwilioApiBaseUrl } from "../twilio-region.js";
import { TwilioApiError, createTwilioApi } from "./api.js";

async function twilioApiRequest(
  overrides: Partial<
    Parameters<typeof createTwilioApi>[0] & {
      endpoint: string;
      body: URLSearchParams | Record<string, string | string[]>;
      allowNotFound?: boolean;
    }
  > = {},
) {
  const params = {
    baseUrl: resolveTwilioApiBaseUrl({ accountSid: "AC123" }),
    accountSid: "AC123",
    authToken: "secret",
    endpoint: "/Calls.json",
    body: {},
    ...overrides,
  };
  return createTwilioApi(params).request(params.endpoint, params.body, {
    allowNotFound: params.allowNotFound,
  });
}

function mockResponse(response = new Response(JSON.stringify({ sid: "CA123" }))) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValue({ response, release });
  return release;
}

describe("twilioApiRequest", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("posts form bodies with basic auth and parses json", async () => {
    const release = mockResponse();

    await expect(
      twilioApiRequest({
        body: {
          To: "+14155550123",
          StatusCallbackEvent: ["initiated", "completed"],
        },
      }),
    ).resolves.toEqual({ sid: "CA123" });

    const [call] = fetchWithSsrFGuardMock.mock.calls;
    assert(call, "expected guarded fetch call");
    const [request] = call;
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
    if (!(requestBody instanceof URLSearchParams)) {
      throw new Error("expected URLSearchParams request body");
    }
    expect(requestBody.toString()).toBe(
      "To=%2B14155550123&StatusCallbackEvent=initiated&StatusCallbackEvent=completed",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("derives the regional hostname for the request and SSRF policy", async () => {
    const release = mockResponse();
    const baseUrl = resolveTwilioApiBaseUrl({ accountSid: "AC123", region: "ie1" });
    await twilioApiRequest({ baseUrl });

    const [call] = fetchWithSsrFGuardMock.mock.calls;
    assert(call, "expected guarded fetch call");
    const [{ url, policy }] = call;
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
    const responses = [new Response("", { status: 200 }), missing.response];
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementation(async () => ({
      response: responses.shift()!,
      release,
    }));

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
    const release = mockResponse(tracked.response);
    const error: unknown = await twilioApiRequest().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TwilioApiError);
    if (!(error instanceof TwilioApiError)) {
      throw new Error("expected Twilio API error");
    }
    expect(error.message).toContain("Twilio API error: 400 ");
    expect(error.message).toContain("... [truncated]");
    expect(error.responseText.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("wraps malformed json success responses with an owned error", async () => {
    const release = mockResponse(new Response("{not json"));

    await expect(twilioApiRequest()).rejects.toThrow("Twilio API returned malformed JSON.");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("exposes structured Twilio error codes from json error bodies", async () => {
    const message = "Call is not in-progress. Cannot redirect.";
    const release = mockResponse(
      new Response(JSON.stringify({ code: 21220, message }), { status: 400 }),
    );
    const request = twilioApiRequest({ endpoint: "/Calls/CA123.json" });
    await expect(request).rejects.toBeInstanceOf(TwilioApiError);
    await expect(request).rejects.toMatchObject({
      name: "TwilioApiError",
      httpStatus: 400,
      twilioCode: 21220,
      message: "Twilio API error: 400 Call is not in-progress. Cannot redirect.",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
