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

function expectWebhookVerificationSucceeds(params: {
  publicKey: string;
  privateKey: crypto.KeyObject;
}) {
  const provider = new TelnyxProvider(
    { apiKey: "KEY123", connectionId: "CONN456", publicKey: params.publicKey },
    { skipVerification: false },
  );

  const rawBody = JSON.stringify({
    event_type: "call.initiated",
    payload: { call_control_id: "x" },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signedPayload = `${timestamp}|${rawBody}`;
  const signature = crypto
    .sign(null, Buffer.from(signedPayload), params.privateKey)
    .toString("base64");

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
}

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
    expectWebhookVerificationSucceeds({ publicKey: rawPublicKeyBase64, privateKey });
  });

  it("verifies a valid signature with a DER SPKI public key (Base64)", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const spkiDerBase64 = spkiDer.toString("base64");
    expectWebhookVerificationSucceeds({ publicKey: spkiDerBase64, privateKey });
  });

  it("returns replay status when the same signed request is seen twice", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: spkiDer.toString("base64") },
      { skipVerification: false },
    );

    const rawBody = JSON.stringify({
      event_type: "call.initiated",
      payload: { call_control_id: "call-replay-test" },
      nonce: crypto.randomUUID(),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedPayload = `${timestamp}|${rawBody}`;
    const signature = crypto.sign(null, Buffer.from(signedPayload), privateKey).toString("base64");
    const ctx = createCtx({
      rawBody,
      headers: {
        "telnyx-signature-ed25519": signature,
        "telnyx-timestamp": timestamp,
      },
    });

    const first = provider.verifyWebhook(ctx);
    const second = provider.verifyWebhook(ctx);

    expect(first.ok).toBe(true);
    expect(first.isReplay).toBeFalsy();
    expect(first.verifiedRequestKey).toBeTruthy();
    expect(second.ok).toBe(true);
    expect(second.isReplay).toBe(true);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
  });
});

describe("TelnyxProvider.parseWebhookEvent", () => {
  it("uses verified request key for manager dedupe", () => {
    const provider = new TelnyxProvider({
      apiKey: "KEY123",
      connectionId: "CONN456",
      publicKey: undefined,
    });
    const result = provider.parseWebhookEvent(
      createCtx({
        rawBody: JSON.stringify({
          data: {
            id: "evt-123",
            event_type: "call.initiated",
            payload: { call_control_id: "call-1" },
          },
        }),
      }),
      { verifiedRequestKey: "telnyx:req:abc" },
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.dedupeKey).toBe("telnyx:req:abc");
  });
});
