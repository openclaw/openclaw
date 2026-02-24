import { describe, expect, it } from "vitest";
import type { WebhookContext } from "../types.js";
import { TwilioProvider } from "./twilio.js";

const STREAM_URL = "wss://example.ngrok.app/voice/stream";

function createProvider(): TwilioProvider {
  return new TwilioProvider(
    { accountSid: "AC123", authToken: "secret" },
    { publicUrl: "https://example.ngrok.app", streamPath: "/voice/stream" },
  );
}

function createContext(rawBody: string, query?: WebhookContext["query"]): WebhookContext {
  return {
    headers: {},
    rawBody,
    url: "https://example.ngrok.app/voice/twilio",
    method: "POST",
    query,
  };
}

describe("TwilioProvider", () => {
  it("returns streaming TwiML for outbound conversation calls before in-progress", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=initiated&Direction=outbound-api&CallSid=CA123", {
      callId: "call-1",
    });

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toContain(STREAM_URL);
    expect(result.providerResponseBody).toContain('<Parameter name="token" value="');
    expect(result.providerResponseBody).toContain("<Connect>");
  });

  it("returns empty TwiML for status callbacks", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=ringing&Direction=outbound-api", {
      callId: "call-1",
      type: "status",
    });

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
  });

  it("returns streaming TwiML for inbound calls", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA456");

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toContain(STREAM_URL);
    expect(result.providerResponseBody).toContain('<Parameter name="token" value="');
    expect(result.providerResponseBody).toContain("<Connect>");
  });

  it("uses a stable dedupeKey for identical request payloads", () => {
    const provider = createProvider();
    const rawBody = "CallSid=CA789&Direction=inbound&SpeechResult=hello";
    const ctxA = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-123" },
    };
    const ctxB = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-123" },
    };

    const eventA = provider.parseWebhookEvent(ctxA).events[0];
    const eventB = provider.parseWebhookEvent(ctxB).events[0];

    expect(eventA).toBeDefined();
    expect(eventB).toBeDefined();
    expect(eventA?.id).not.toBe(eventB?.id);
    expect(eventA?.dedupeKey).toBe("twilio:idempotency:idem-123");
    expect(eventA?.dedupeKey).toBe(eventB?.dedupeKey);
  });

  it("keeps turnToken from query on speech events", () => {
    const provider = createProvider();
    const ctx = createContext("CallSid=CA222&Direction=inbound&SpeechResult=hello", {
      callId: "call-2",
      turnToken: "turn-xyz",
    });

    const event = provider.parseWebhookEvent(ctx).events[0];
    expect(event?.type).toBe("call.speech");
    expect(event?.turnToken).toBe("turn-xyz");
  });
});
