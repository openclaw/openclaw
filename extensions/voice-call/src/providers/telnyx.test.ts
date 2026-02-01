import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WebhookContext } from "../types.js";
import { TelnyxProvider } from "./telnyx.js";

function createCtx(params: {
  rawBody: string;
  signature?: string;
  timestamp?: string;
}): WebhookContext {
  return {
    headers: {
      "telnyx-signature-ed25519": params.signature,
      "telnyx-timestamp": params.timestamp,
    },
    rawBody: params.rawBody,
    url: "https://example.test/voice/webhook",
    method: "POST",
  };
}

function createKeypair(): { publicKeyB64DerSpki: string; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    publicKeyB64DerSpki: Buffer.from(publicKeyDer).toString("base64"),
    privateKey,
  };
}

function signEd25519(params: {
  privateKey: crypto.KeyObject;
  timestamp: string;
  rawBody: string;
}): string {
  const signedPayload = `${params.timestamp}|${params.rawBody}`;
  const sig = crypto.sign(null, Buffer.from(signedPayload), params.privateKey);
  return Buffer.from(sig).toString("base64");
}

describe("TelnyxProvider.verifyWebhook", () => {
  it("fails closed when publicKey is missing (and skipVerification is false)", () => {
    const provider = new TelnyxProvider({ apiKey: "KEY", connectionId: "CONN" });
    const result = provider.verifyWebhook(createCtx({ rawBody: "{}" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/public key not configured/i);
  });

  it("allows when skipVerification is enabled (dev only)", () => {
    const provider = new TelnyxProvider(
      { apiKey: "KEY", connectionId: "CONN" },
      { skipVerification: true },
    );
    const result = provider.verifyWebhook(createCtx({ rawBody: "{}" }));
    expect(result.ok).toBe(true);
  });

  it("accepts a valid Ed25519 signature with a fresh timestamp", () => {
    const { publicKeyB64DerSpki, privateKey } = createKeypair();
    const provider = new TelnyxProvider({
      apiKey: "KEY",
      connectionId: "CONN",
      publicKey: publicKeyB64DerSpki,
    });

    const rawBody = JSON.stringify({
      data: { id: "evt-1", event_type: "call.initiated", payload: {} },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signEd25519({ privateKey, timestamp, rawBody });

    const result = provider.verifyWebhook(createCtx({ rawBody, timestamp, signature }));
    expect(result.ok).toBe(true);
  });

  it("rejects invalid timestamps even if the signature matches the payload", () => {
    const { publicKeyB64DerSpki, privateKey } = createKeypair();
    const provider = new TelnyxProvider({
      apiKey: "KEY",
      connectionId: "CONN",
      publicKey: publicKeyB64DerSpki,
    });

    const rawBody = "{}";
    const timestamp = "not-a-number";
    const signature = signEd25519({ privateKey, timestamp, rawBody });

    const result = provider.verifyWebhook(createCtx({ rawBody, timestamp, signature }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/invalid timestamp/i);
  });

  it("rejects too-old timestamps", () => {
    const { publicKeyB64DerSpki, privateKey } = createKeypair();
    const provider = new TelnyxProvider({
      apiKey: "KEY",
      connectionId: "CONN",
      publicKey: publicKeyB64DerSpki,
    });

    const rawBody = "{}";
    const timestamp = String(Math.floor((Date.now() - 6 * 60 * 1000) / 1000));
    const signature = signEd25519({ privateKey, timestamp, rawBody });

    const result = provider.verifyWebhook(createCtx({ rawBody, timestamp, signature }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timestamp too old/i);
  });
});
