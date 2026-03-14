import { describe, expect, it, vi } from "vitest";

// Mock the twilio-shared module before importing send.ts
vi.mock("openclaw/plugin-sdk/twilio-shared", () => ({
  twilioApiRequest: vi.fn(),
}));

import { twilioApiRequest } from "openclaw/plugin-sdk/twilio-shared";
import { sendTwilioSms } from "./send.js";

const mockTwilioApi = vi.mocked(twilioApiRequest);

describe("sendTwilioSms", () => {
  const baseParams = {
    to: "+15559876543",
    body: "Hello from OpenClaw",
    accountSid: "AC_test_sid",
    authToken: "test_auth_token",
    from: "+15551234567",
  };

  it("sends an SMS and returns the SID", async () => {
    mockTwilioApi.mockResolvedValueOnce({ sid: "SM_test_123", status: "queued" });

    const result = await sendTwilioSms(baseParams);

    expect(result).toEqual({ ok: true, sid: "SM_test_123", status: "queued" });
    expect(mockTwilioApi).toHaveBeenCalledWith({
      accountSid: "AC_test_sid",
      authToken: "test_auth_token",
      endpoint: "/2010-04-01/Accounts/AC_test_sid/Messages.json",
      body: {
        To: "+15559876543",
        From: "+15551234567",
        Body: "Hello from OpenClaw",
      },
    });
  });

  it("includes MediaUrl for MMS", async () => {
    mockTwilioApi.mockResolvedValueOnce({ sid: "SM_mms_456", status: "queued" });

    const result = await sendTwilioSms({
      ...baseParams,
      mediaUrl: ["https://example.com/image.jpg"],
    });

    expect(result.ok).toBe(true);
    expect(mockTwilioApi).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          MediaUrl: ["https://example.com/image.jpg"],
        }),
      }),
    );
  });

  it("does not include MediaUrl when empty array", async () => {
    mockTwilioApi.mockResolvedValueOnce({ sid: "SM_789", status: "queued" });

    await sendTwilioSms({ ...baseParams, mediaUrl: [] });

    const call = mockTwilioApi.mock.calls[0][0];
    expect(call.body).not.toHaveProperty("MediaUrl");
  });

  it("propagates API errors", async () => {
    mockTwilioApi.mockRejectedValueOnce(new Error("Twilio API error: 401 Unauthorized"));

    await expect(sendTwilioSms(baseParams)).rejects.toThrow("Twilio API error: 401");
  });
});
