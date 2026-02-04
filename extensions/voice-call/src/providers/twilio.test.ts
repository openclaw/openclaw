import { describe, expect, it } from "vitest";
import type { WebhookContext } from "../types.js";
import { TwilioProvider } from "./twilio.js";

<<<<<<< HEAD
const STREAM_URL = "wss://example.ngrok.app/voice/stream";
=======
const STREAM_URL_PREFIX = "wss://example.ngrok.app/voice/stream?token=";
>>>>>>> upstream/main

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
<<<<<<< HEAD
    const ctx = createContext("CallStatus=initiated&Direction=outbound-api", {
=======
    const ctx = createContext("CallStatus=initiated&Direction=outbound-api&CallSid=CA123", {
>>>>>>> upstream/main
      callId: "call-1",
    });

    const result = provider.parseWebhookEvent(ctx);

<<<<<<< HEAD
    expect(result.providerResponseBody).toContain(STREAM_URL);
=======
    expect(result.providerResponseBody).toContain(STREAM_URL_PREFIX);
>>>>>>> upstream/main
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
<<<<<<< HEAD
    const ctx = createContext("CallStatus=ringing&Direction=inbound");

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toContain(STREAM_URL);
=======
    const ctx = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA456");

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toContain(STREAM_URL_PREFIX);
>>>>>>> upstream/main
    expect(result.providerResponseBody).toContain("<Connect>");
  });
});
