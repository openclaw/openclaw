import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WebhookContext } from "../types.js";
import { TelnyxProvider } from "./telnyx.js";

function createCtx(params?: Partial<WebhookContext>): WebhookContext {
  return {
    headers: {},
    rawBody: "{}",
    url: "http://localhost/voice/webhook",
    method: "POST",
    query: {},
    remoteAddress: "127.0.0.1",
    ...params,
  };
}

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  return Buffer.from(padded, "base64");
}

describe("TelnyxProvider.parseWebhookEvent", () => {
  function makeProvider() {
    return new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: undefined },
      { skipVerification: true },
    );
  }

  it("parses direction, from, and to from call.initiated payload", () => {
    const provider = makeProvider();
    const result = provider.parseWebhookEvent(
      createCtx({
        rawBody: JSON.stringify({
          data: {
            id: "evt_123",
            event_type: "call.initiated",
            payload: {
              call_control_id: "cc_123",
              direction: "incoming",
              from: "+15551234567",
              to: "+15559876543",
            },
          },
        }),
      }),
    );
    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event.type).toBe("call.initiated");
    expect(event.direction).toBe("inbound");
    expect(event.from).toBe("+15551234567");
    expect(event.to).toBe("+15559876543");
  });

  it("parses outgoing direction correctly", () => {
    const provider = makeProvider();
    const result = provider.parseWebhookEvent(
      createCtx({
        rawBody: JSON.stringify({
          data: {
            id: "evt_456",
            event_type: "call.initiated",
            payload: {
              call_control_id: "cc_456",
              direction: "outgoing",
              from: "+15559876543",
              to: "+15551234567",
            },
          },
        }),
      }),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].direction).toBe("outbound");
  });

  it("handles missing direction gracefully", () => {
    const provider = makeProvider();
    const result = provider.parseWebhookEvent(
      createCtx({
        rawBody: JSON.stringify({
          data: {
            id: "evt_789",
            event_type: "call.answered",
            payload: {
              call_control_id: "cc_789",
            },
          },
        }),
      }),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].direction).toBeUndefined();
  });
});

describe("TelnyxProvider.verifyWebhook", () => {
  it("fails closed when public key is missing and skipVerification is false", () => {
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: undefined },
      { skipVerification: false },
    );

    const result = provider.verifyWebhook(createCtx());
    expect(result.ok).toBe(false);
  });

  it("allows requests when skipVerification is true (development only)", () => {
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: undefined },
      { skipVerification: true },
    );

    const result = provider.verifyWebhook(createCtx());
    expect(result.ok).toBe(true);
  });

  it("fails when signature headers are missing (with public key configured)", () => {
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: "public-key" },
      { skipVerification: false },
    );

    const result = provider.verifyWebhook(createCtx({ headers: {} }));
    expect(result.ok).toBe(false);
  });

  it("verifies a valid signature with a raw Ed25519 public key (Base64)", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

    const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("Ed25519");
    expect(typeof jwk.x).toBe("string");

    const rawPublicKey = decodeBase64Url(jwk.x as string);
    const rawPublicKeyBase64 = rawPublicKey.toString("base64");

    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: rawPublicKeyBase64 },
      { skipVerification: false },
    );

    const rawBody = JSON.stringify({
      event_type: "call.initiated",
      payload: { call_control_id: "x" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedPayload = `${timestamp}|${rawBody}`;
    const signature = crypto.sign(null, Buffer.from(signedPayload), privateKey).toString("base64");

    const result = provider.verifyWebhook(
      createCtx({
        rawBody,
        headers: {
          "telnyx-signature-ed25519": signature,
          "telnyx-timestamp": timestamp,
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("verifies a valid signature with a DER SPKI public key (Base64)", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const spkiDerBase64 = spkiDer.toString("base64");

    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: spkiDerBase64 },
      { skipVerification: false },
    );

    const rawBody = JSON.stringify({
      event_type: "call.initiated",
      payload: { call_control_id: "x" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedPayload = `${timestamp}|${rawBody}`;
    const signature = crypto.sign(null, Buffer.from(signedPayload), privateKey).toString("base64");

    const result = provider.verifyWebhook(
      createCtx({
        rawBody,
        headers: {
          "telnyx-signature-ed25519": signature,
          "telnyx-timestamp": timestamp,
        },
      }),
    );
    expect(result.ok).toBe(true);
  });
});
