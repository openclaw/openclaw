import { webcrypto } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AutofillRelayClient } from "./autofill-relay.js";

type EnvelopePurpose = "integration_key" | "tokens";

const subtle = webcrypto.subtle;
const encode = new TextEncoder();

// Independent sender implementation, matching the relay's published protocol rather than its opener.
async function seal(
  publicKey: webcrypto.CryptoKey,
  plaintext: string,
  sessionId: string,
  purpose: EnvelopePurpose,
): Promise<Record<string, unknown>> {
  const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const shared = await subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    ephemeral.privateKey,
    256,
  );
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encode.encode("openclaw-connect/v1/" + purpose),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encode.encode(sessionId + "\n" + purpose) },
    aes,
    encode.encode(plaintext),
  );
  const jwk = await subtle.exportKey("jwk", ephemeral.publicKey);
  if (!jwk.x || !jwk.y) {
    throw new Error("fixture public key is incomplete");
  }
  return {
    v: 1,
    alg: "ECDH-ES+HKDF-SHA256+A256GCM",
    purpose,
    epk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    iv: Buffer.from(iv).toString("base64url"),
    ct: Buffer.from(ct).toString("base64url"),
  };
}

it("opens independent WebCrypto envelopes at pickup and rejects session, purpose, version, and ciphertext tampering", async () => {
  const sessionId = "s".repeat(22);
  const tokens = JSON.stringify({
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    expires_in: 900,
    scope: "brokered-credentials:read",
  });
  let gateway: webcrypto.CryptoKey | undefined;
  let sealKey: (key: webcrypto.CryptoKey) => Promise<Record<string, unknown>>;
  const client = new AutofillRelayClient(
    vi.fn<typeof fetch>(async (input, init) => {
      if (typeof input === "string" && input.endsWith("/sessions")) {
        if (typeof init?.body !== "string") {
          throw new Error("Relay fixture expects a JSON string body");
        }
        const { gatewayPublicKey } = JSON.parse(init.body) as {
          gatewayPublicKey: webcrypto.JsonWebKey;
        };
        gateway = await subtle.importKey(
          "jwk",
          gatewayPublicKey,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        );
        return Response.json(
          {
            sessionId,
            pickupToken: "p".repeat(43),
            connectUrl: `https://connect.openclaw.ai/1password/start/${sessionId}`,
            confirmationCode: "ABCD-1234",
            expiresAt: "2026-11-02T23:59:00Z",
          },
          { status: 201 },
        );
      }
      if (!gateway) {
        throw new Error("Relay fixture expects a session first");
      }
      return Response.json({
        state: "connected",
        sealedIntegrationKey: await sealKey(gateway),
        sealedTokens: await seal(gateway, tokens, sessionId, "tokens"),
      });
    }),
  );
  const session = await client.create();
  sealKey = (key) => seal(key, "synthetic-integration-key", sessionId, "integration_key");
  await expect(client.pickup(session)).resolves.toMatchObject({
    state: "connected",
    integrationKey: "synthetic-integration-key",
  });
  for (const tamper of [
    (key: webcrypto.CryptoKey) =>
      seal(key, "synthetic-integration-key", "t".repeat(22), "integration_key"),
    (key: webcrypto.CryptoKey) => seal(key, "synthetic-integration-key", sessionId, "tokens"),
    async (key: webcrypto.CryptoKey) => ({
      ...(await seal(key, "synthetic-integration-key", sessionId, "integration_key")),
      v: 2,
    }),
    async (key: webcrypto.CryptoKey) => ({
      ...(await seal(key, "synthetic-integration-key", sessionId, "integration_key")),
      ct: "AA",
    }),
  ]) {
    sealKey = tamper;
    await expect(client.pickup(session)).rejects.toMatchObject({ code: "invalidRelayResponse" });
  }
});

it("uses the exact relay wire contract for session, pickup, rotation, and direct revocation", async () => {
  const sessionId = "s".repeat(22);
  const pickupToken = "p".repeat(43);
  let gateway: webcrypto.CryptoKey;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const tokens = {
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    expires_in: 900,
    scope: "brokered-credentials:read",
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (typeof input !== "string") {
      throw new Error("Relay fixture expects an explicit URL string");
    }
    const url = input;
    calls.push({ url, init });
    if (url.endsWith("/sessions")) {
      if (typeof init?.body !== "string") {
        throw new Error("Relay fixture expects a JSON string body");
      }
      const body: unknown = JSON.parse(init.body);
      expect(body).toMatchObject({ gatewayPublicKey: { kty: "EC", crv: "P-256" } });
      const parsed = JSON.parse(init.body) as { gatewayPublicKey: webcrypto.JsonWebKey };
      expect(Object.keys(parsed.gatewayPublicKey).toSorted()).toEqual(["crv", "kty", "x", "y"]);
      gateway = await subtle.importKey(
        "jwk",
        parsed.gatewayPublicKey,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
      return Response.json(
        {
          sessionId,
          pickupToken,
          connectUrl: `https://connect.openclaw.ai/1password/start/${sessionId}`,
          confirmationCode: "ABCD-1234",
          expiresAt: "2026-11-02T23:59:00Z",
        },
        { status: 201 },
      );
    }
    if (url.includes("/sessions/")) {
      expect(init?.headers).toEqual({ authorization: `Bearer ${pickupToken}` });
      return Response.json({
        state: "connected",
        sealedIntegrationKey: null,
        sealedTokens: await seal(gateway, JSON.stringify(tokens), sessionId, "tokens"),
      });
    }
    if (url.endsWith("/refresh")) {
      expect(init?.body).toBe(JSON.stringify({ refreshToken: "synthetic-refresh" }));
      return Response.json(tokens);
    }
    expect(url).toBe("https://api.1password.com/v1alpha1/oauth-integrations/self:revoke");
    expect(init?.body).toBe("{}");
    return Response.json({});
  });
  const client = new AutofillRelayClient(fetcher);
  const session = await client.create();
  expect(await client.pickup(session)).toEqual({
    state: "connected",
    tokens,
    integrationKey: null,
  });
  expect(await client.refresh(tokens.refresh_token)).toEqual(tokens);
  await client.revoke(tokens.access_token);
  expect(calls).toHaveLength(4);
  expect(calls.every(({ init }) => init?.redirect === "error" && init.cache === "no-store")).toBe(
    true,
  );
});

it("never reflects upstream bodies or network errors and treats invalid_grant as terminal", async () => {
  const secret = "synthetic-sensitive-error";
  const invalid = new AutofillRelayClient(
    vi.fn<typeof fetch>(async () =>
      Response.json({ error: "invalid_grant", detail: secret }, { status: 400 }),
    ),
  );
  await expect(invalid.refresh("synthetic-refresh")).rejects.toMatchObject({
    code: "reconnectRequired",
  });
  const failed = new AutofillRelayClient(
    vi.fn<typeof fetch>(async () => {
      throw new Error(secret);
    }),
  );
  await expect(failed.create()).rejects.not.toThrow(secret);
});
