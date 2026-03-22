import { describe, expect, it } from "vitest";
import { PlivoProvider } from "./plivo.js";

function requireEvent<T>(event: T | undefined, message: string): T {
  if (!event) {
    throw new Error(message);
  }
  return event;
}

describe("PlivoProvider", () => {
  it("parses answer callback into call.answered and returns keep-alive XML", () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });

    const result = provider.parseWebhookEvent({
      headers: { host: "example.com" },
      rawBody:
        "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
      url: "https://example.com/voice/webhook?provider=plivo&flow=answer&callId=internal-call-id",
      method: "POST",
      query: { provider: "plivo", flow: "answer", callId: "internal-call-id" },
    });

    expect(result.events).toHaveLength(1);
    const event = requireEvent(result.events[0], "expected Plivo answer event");
    expect(event.type).toBe("call.answered");
    expect(event.callId).toBe("internal-call-id");
    expect(event.providerCallId).toBe("call-uuid");
    expect(result.providerResponseBody).toContain("<Wait");
    expect(result.providerResponseBody).toContain('length="300"');
  });

  it("uses verified request key when provided", () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });

    const result = provider.parseWebhookEvent(
      {
        headers: { host: "example.com", "x-plivo-signature-v3-nonce": "nonce-1" },
        rawBody:
          "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
        url: "https://example.com/voice/webhook?provider=plivo&flow=answer&callId=internal-call-id",
        method: "POST",
        query: { provider: "plivo", flow: "answer", callId: "internal-call-id" },
      },
      { verifiedRequestKey: "plivo:v3:verified" },
    );

    expect(result.events).toHaveLength(1);
    expect(requireEvent(result.events[0], "expected verified Plivo event").dedupeKey).toBe(
      "plivo:v3:verified",
    );
  });
});
