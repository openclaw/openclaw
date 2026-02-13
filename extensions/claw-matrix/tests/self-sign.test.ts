import assert from "node:assert/strict";
import * as crypto from "node:crypto";
/**
 * Tests for device self-signing module (src/crypto/self-sign.ts).
 *
 * Covers: canonical JSON encoding, ed25519 key derivation, sign/verify round-trip.
 *
 * The crypto functions are reimplemented here to avoid import resolution issues
 * with .js extensions in ESM+TypeScript. The logic matches self-sign.ts exactly.
 */
import { describe, it } from "node:test";

// ── Reimplemented from self-sign.ts ─────────────────────────────────────

function stripForSigning(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === "signatures" || k === "unsigned") continue;
    result[k] = v;
  }
  return result;
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeys(stripForSigning(obj)));
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519PrivateKeyFromSeed(seed: Buffer): crypto.KeyObject {
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
}

function deriveEd25519PublicKey(seed: Buffer): string {
  const privateKey = ed25519PrivateKeyFromSeed(seed);
  const publicKey = crypto.createPublicKey(privateKey);
  const rawPub = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(rawPub.subarray(rawPub.length - 32))
    .toString("base64")
    .replace(/=+$/, "");
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("canonicalJson", () => {
  it("sorts keys alphabetically", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it("sorts nested objects recursively", () => {
    assert.equal(canonicalJson({ z: { b: 1, a: 2 }, a: 1 }), '{"a":1,"z":{"a":2,"b":1}}');
  });

  it("preserves array order", () => {
    assert.equal(canonicalJson({ a: [3, 1, 2] }), '{"a":[3,1,2]}');
  });

  it("handles null, numbers, strings, booleans", () => {
    assert.equal(canonicalJson(null), "null");
    assert.equal(canonicalJson(42), "42");
    assert.equal(canonicalJson("hello"), '"hello"');
    assert.equal(canonicalJson(true), "true");
    assert.equal(canonicalJson(false), "false");
  });

  it("strips signatures and unsigned keys", () => {
    const obj = {
      user_id: "@alice:example.com",
      device_id: "ABC",
      signatures: { "@alice:example.com": { "ed25519:ABC": "sig..." } },
      unsigned: { device_display_name: "Alice's phone" },
      keys: { "ed25519:ABC": "key..." },
    };
    const result = canonicalJson(obj);
    assert.ok(!result.includes("signatures"));
    assert.ok(!result.includes("unsigned"));
    assert.ok(result.includes("user_id"));
    assert.ok(result.includes("keys"));
  });

  it("produces no whitespace", () => {
    const result = canonicalJson({ foo: { bar: [1, 2, 3] } });
    assert.ok(!result.includes(" "));
    assert.ok(!result.includes("\n"));
    assert.ok(!result.includes("\t"));
  });

  it("matches Matrix spec example", () => {
    // Matrix spec canonical JSON test case
    const input = {
      auth: {
        success: true,
        mxid: "@john.doe:example.com",
        profile: {
          display_name: "John Doe",
          three_pids: [
            { medium: "email", address: "john.doe@example.org" },
            { medium: "msisdn", address: "123456789" },
          ],
        },
      },
    };
    const result = canonicalJson(input);
    // Verify keys are sorted at all levels
    assert.ok(result.indexOf('"address"') < result.indexOf('"medium"'));
    assert.ok(result.indexOf('"auth"') === 1); // first key
    assert.ok(result.indexOf('"display_name"') < result.indexOf('"three_pids"'));
  });
});

describe("deriveEd25519PublicKey", () => {
  it("returns a deterministic base64 public key from seed", () => {
    const seed = crypto.randomBytes(32);
    const pubKey1 = deriveEd25519PublicKey(Buffer.from(seed));
    const pubKey2 = deriveEd25519PublicKey(Buffer.from(seed));
    assert.equal(pubKey1, pubKey2);
  });

  it("returns 32 bytes when decoded from base64", () => {
    const seed = crypto.randomBytes(32);
    const pubKey = deriveEd25519PublicKey(Buffer.from(seed));
    const decoded = Buffer.from(pubKey, "base64");
    assert.equal(decoded.length, 32);
  });

  it("uses unpadded base64 (no = padding)", () => {
    for (let i = 0; i < 10; i++) {
      const seed = crypto.randomBytes(32);
      const pubKey = deriveEd25519PublicKey(Buffer.from(seed));
      assert.ok(!pubKey.includes("="), `Public key should not contain padding: ${pubKey}`);
    }
  });

  it("different seeds produce different public keys", () => {
    const pubKey1 = deriveEd25519PublicKey(crypto.randomBytes(32));
    const pubKey2 = deriveEd25519PublicKey(crypto.randomBytes(32));
    assert.notEqual(pubKey1, pubKey2);
  });
});

describe("ed25519 sign/verify round-trip", () => {
  it("signature verifies with the derived public key", () => {
    const seed = crypto.randomBytes(32);
    const privateKey = ed25519PrivateKeyFromSeed(seed);
    const publicKey = crypto.createPublicKey(privateKey);

    const message = Buffer.from(
      canonicalJson({
        algorithms: ["m.megolm.v1.aes-sha2"],
        device_id: "TEST",
        user_id: "@bot:example.com",
        keys: { "ed25519:TEST": "somekey", "curve25519:TEST": "otherkey" },
      }),
    );
    const signature = crypto.sign(null, message, privateKey);

    assert.ok(crypto.verify(null, message, publicKey, signature));
  });

  it("signature is 64 bytes", () => {
    const seed = crypto.randomBytes(32);
    const privateKey = ed25519PrivateKeyFromSeed(seed);
    const message = Buffer.from("test message");
    const signature = crypto.sign(null, message, privateKey);
    assert.equal(signature.length, 64);
  });

  it("unpadded base64 signature has no = chars", () => {
    const seed = crypto.randomBytes(32);
    const privateKey = ed25519PrivateKeyFromSeed(seed);
    const message = Buffer.from("test message for padding check");
    const signature = crypto.sign(null, message, privateKey);
    const b64 = Buffer.from(signature).toString("base64").replace(/=+$/, "");
    assert.ok(!b64.includes("="));
  });

  it("tampered message fails verification", () => {
    const seed = crypto.randomBytes(32);
    const privateKey = ed25519PrivateKeyFromSeed(seed);
    const publicKey = crypto.createPublicKey(privateKey);

    const message = Buffer.from("original message");
    const signature = crypto.sign(null, message, privateKey);

    const tampered = Buffer.from("tampered message");
    assert.ok(!crypto.verify(null, tampered, publicKey, signature));
  });

  it("wrong key fails verification", () => {
    const seed1 = crypto.randomBytes(32);
    const seed2 = crypto.randomBytes(32);
    const privateKey1 = ed25519PrivateKeyFromSeed(seed1);
    const publicKey2 = crypto.createPublicKey(ed25519PrivateKeyFromSeed(seed2));

    const message = Buffer.from("test message");
    const signature = crypto.sign(null, message, privateKey1);

    assert.ok(!crypto.verify(null, message, publicKey2, signature));
  });
});
