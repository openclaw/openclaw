import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { VonageProvider } from "./vonage.js";

function base64url(input: Buffer | string): string {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return source.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createHs256Jwt(secret: string, payload: Record<string, unknown>): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = base64url(crypto.createHmac("sha256", secret).update(data).digest());
  return `${data}.${signature}`;
}

describe("VonageProvider", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("verifies signed webhook token and parses lifecycle event", () => {
    const provider = new VonageProvider({
      applicationId: "app-id",
      privateKey: privateKeyPem,
      signatureSecret: "secret",
    });

    const token = createHs256Jwt("secret", {
      iat: Math.floor(Date.now() / 1000),
      jti: "jti-1",
    });

    const verification = provider.verifyWebhook({
      headers: { authorization: `Bearer ${token}` },
      rawBody: JSON.stringify({ status: "ringing", uuid: "provider-call-id" }),
      url: "https://example.com/voice/webhook?flow=event&callId=call-1",
      method: "POST",
      query: { flow: "event", callId: "call-1" },
    });

    expect(verification.ok).toBe(true);

    const parsed = provider.parseWebhookEvent(
      {
        headers: { host: "example.com" },
        rawBody: JSON.stringify({ status: "ringing", uuid: "provider-call-id" }),
        url: "https://example.com/voice/webhook?flow=event&callId=call-1",
        method: "POST",
        query: { flow: "event", callId: "call-1" },
      },
      { verifiedRequestKey: verification.verifiedRequestKey },
    );

    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.type).toBe("call.ringing");
    expect(parsed.events[0]?.callId).toBe("call-1");
  });

  it("returns NCCO for answer flow", () => {
    const provider = new VonageProvider({
      applicationId: "app-id",
      privateKey: privateKeyPem,
      signatureSecret: "secret",
    });

    const parsed = provider.parseWebhookEvent({
      headers: { host: "example.com" },
      rawBody: JSON.stringify({ uuid: "provider-call-id" }),
      url: "https://example.com/voice/webhook?flow=answer&callId=call-1",
      method: "POST",
      query: { flow: "answer", callId: "call-1" },
    });

    expect(parsed.providerResponseHeaders?.["Content-Type"]).toBe("application/json");
    expect(parsed.providerResponseBody).toContain("conversation");
  });
});
