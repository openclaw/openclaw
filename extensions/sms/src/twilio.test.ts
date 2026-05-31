import { describe, expect, it, vi } from "vitest";
import {
  buildTwilioInboundMessage,
  computeTwilioSignature,
  parseTwilioFormBody,
  sendSmsViaTwilio,
  verifyTwilioSignature,
} from "./twilio.js";

describe("Twilio SMS helpers", () => {
  it("parses Twilio form bodies and inbound messages", () => {
    const form = parseTwilioFormBody(
      "From=%2B15551234567&To=%2B15557654321&Body=hello+there&MessageSid=SM123",
    );

    expect(form).toEqual({
      From: "+15551234567",
      To: "+15557654321",
      Body: "hello there",
      MessageSid: "SM123",
    });
    expect(buildTwilioInboundMessage(form)).toEqual({
      from: "+15551234567",
      to: "+15557654321",
      body: "hello there",
      messageSid: "SM123",
    });
  });

  it("verifies Twilio signatures over sorted form fields", () => {
    const form = {
      Body: "hello",
      From: "+15551234567",
      MessageSid: "SM123",
      To: "+15557654321",
    };
    const signature = computeTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form,
    });

    expect(
      verifyTwilioSignature({
        signature,
        url: "https://gateway.example.com/webhooks/sms",
        authToken: "secret",
        form,
      }),
    ).toBe(true);
    expect(
      verifyTwilioSignature({
        signature,
        url: "https://gateway.example.com/webhooks/sms/other",
        authToken: "secret",
        form,
      }),
    ).toBe(false);
  });

  it("preserves signed form values before signature verification", () => {
    const form = parseTwilioFormBody(
      "From=%2B15551234567&To=%2B15557654321&Body=+hello+&MessageSid=SM123&WaId=",
    );
    const signature = computeTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form,
    });

    expect(form.Body).toBe(" hello ");
    expect(form.WaId).toBe("");
    expect(
      verifyTwilioSignature({
        signature,
        url: "https://gateway.example.com/webhooks/sms",
        authToken: "secret",
        form,
      }),
    ).toBe(true);
    expect(buildTwilioInboundMessage(form)?.body).toBe(" hello ");
  });

  it("sends SMS through Twilio's Messages API", async () => {
    const release = vi.fn();
    const fetchWithGuard = vi.fn(async () => ({
      response: new Response(JSON.stringify({ sid: "SM456" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
      release,
    }));

    await expect(
      sendSmsViaTwilio({
        account: {
          accountId: "default",
          enabled: true,
          accountSid: "AC123",
          authToken: "secret",
          fromNumber: "+15557654321",
          webhookPath: "/webhooks/sms",
          publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
          dangerouslyDisableSignatureValidation: false,
          dmPolicy: "pairing",
          allowFrom: [],
          textChunkLimit: 1500,
        },
        to: "+15551234567",
        text: "hello",
        fetchWithGuard,
      }),
    ).resolves.toEqual({ sid: "SM456", to: "+15551234567" });

    const [request] = fetchWithGuard.mock.calls[0] ?? [];
    expect(request?.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(String(request?.init?.body)).toBe("From=%2B15557654321&To=%2B15551234567&Body=hello");
    expect(request?.policy).toEqual({ allowedHostnames: ["api.twilio.com"] });
    expect(request?.timeoutMs).toBe(30_000);
    expect(request?.auditContext).toBe("sms.twilio.api");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
