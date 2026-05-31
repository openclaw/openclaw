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
      accountSid: "",
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
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ sid: "SM456" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      sendSmsViaTwilio({
        account: {
          accountId: "default",
          enabled: true,
          accountSid: "AC123",
          authToken: "secret",
          fromNumber: "+15557654321",
          messagingServiceSid: "",
          webhookPath: "/webhooks/sms",
          publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
          dangerouslyDisableSignatureValidation: false,
          dmPolicy: "pairing",
          allowFrom: [],
          textChunkLimit: 1500,
        },
        to: "+15551234567",
        text: "hello",
        fetchImpl,
      }),
    ).resolves.toEqual({ sid: "SM456", to: "+15551234567" });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    });
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("From")).toBe("+15557654321");
    expect(body.get("To")).toBe("+15551234567");
    expect(body.get("Body")).toBe("hello");
  });

  it("can send through a Twilio Messaging Service SID", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ sid: "SM789" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    await sendSmsViaTwilio({
      account: {
        accountId: "default",
        enabled: true,
        accountSid: "AC123",
        authToken: "secret",
        fromNumber: "",
        messagingServiceSid: "MG123",
        webhookPath: "/webhooks/sms",
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
        dangerouslyDisableSignatureValidation: false,
        dmPolicy: "pairing",
        allowFrom: [],
        textChunkLimit: 1500,
      },
      to: "+15551234567",
      text: "hello",
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("MessagingServiceSid")).toBe("MG123");
    expect(body.get("To")).toBe("+15551234567");
    expect(body.get("Body")).toBe("hello");
  });

  it("prefers an explicit from number when both sender options are resolved", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ sid: "SM999" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    await sendSmsViaTwilio({
      account: {
        accountId: "default",
        enabled: true,
        accountSid: "AC123",
        authToken: "secret",
        fromNumber: "+15557654321",
        messagingServiceSid: "MG123",
        webhookPath: "/webhooks/sms",
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
        dangerouslyDisableSignatureValidation: false,
        dmPolicy: "pairing",
        allowFrom: [],
        textChunkLimit: 1500,
      },
      to: "+15551234567",
      text: "hello",
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("From")).toBe("+15557654321");
    expect(body.get("MessagingServiceSid")).toBeNull();
  });
});
