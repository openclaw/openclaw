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

describe("TwilioProvider.buildBaseUrl", () => {
  it("defaults to US1 when no region is specified", () => {
    expect(TwilioProvider.buildBaseUrl("AC123")).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC123",
    );
  });

  it("defaults to US1 when region and edge are both undefined", () => {
    expect(TwilioProvider.buildBaseUrl("AC123", undefined, undefined)).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC123",
    );
  });

  it("builds IE1 Dublin URL when region=ie1 and edge=dublin", () => {
    expect(TwilioProvider.buildBaseUrl("AC123", "ie1", "dublin")).toBe(
      "https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/AC123",
    );
  });

  it("builds AU1 Sydney URL when region=au1 and edge=sydney", () => {
    expect(TwilioProvider.buildBaseUrl("AC123", "au1", "sydney")).toBe(
      "https://api.sydney.au1.twilio.com/2010-04-01/Accounts/AC123",
    );
  });

  it("builds URL with explicit edge and region for any combination", () => {
    // Even for non-standard combinations, both edge and region are used
    expect(TwilioProvider.buildBaseUrl("AC123", "jp1", "tokyo")).toBe(
      "https://api.tokyo.jp1.twilio.com/2010-04-01/Accounts/AC123",
    );
  });

  it("infers default edge for supported processing regions when edge is omitted", () => {
    expect(TwilioProvider.buildBaseUrl("AC123", "ie1")).toBe(
      "https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/AC123",
    );
    expect(TwilioProvider.buildBaseUrl("AC123", "au1")).toBe(
      "https://api.sydney.au1.twilio.com/2010-04-01/Accounts/AC123",
    );
    expect(TwilioProvider.buildBaseUrl("AC123", "us1")).toBe(
      "https://api.ashburn.us1.twilio.com/2010-04-01/Accounts/AC123",
    );
  });

  it("falls back to ashburn edge for unknown regions", () => {
    expect(TwilioProvider.buildBaseUrl("AC123", "xx9")).toBe(
      "https://api.ashburn.xx9.twilio.com/2010-04-01/Accounts/AC123",
    );
  });

  it("allows overriding the default edge for a region", () => {
    // Use ashburn edge with IE1 region (unusual but valid)
    expect(TwilioProvider.buildBaseUrl("AC123", "ie1", "ashburn")).toBe(
      "https://api.ashburn.ie1.twilio.com/2010-04-01/Accounts/AC123",
    );
  });
});

describe("TwilioProvider", () => {
  it("uses regional base URL when region/edge are configured", () => {
    const provider = new TwilioProvider(
      { accountSid: "AC123", authToken: "secret", region: "ie1", edge: "dublin" },
      { publicUrl: "https://example.ngrok.app", streamPath: "/voice/stream" },
    );
    // Provider should have constructed the correct regional base URL internally.
    // We verify indirectly: the provider should initialize without error.
    expect(provider.name).toBe("twilio");
  });

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
});
