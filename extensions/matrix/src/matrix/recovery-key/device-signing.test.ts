import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonStringify, signDevice } from "./device-signing.js";

describe("canonicalJsonStringify", () => {
  it("serializes null", () => {
    expect(canonicalJsonStringify(null)).toBe("null");
  });

  it("serializes strings", () => {
    expect(canonicalJsonStringify("hello")).toBe('"hello"');
  });

  it("serializes numbers", () => {
    expect(canonicalJsonStringify(42)).toBe("42");
  });

  it("serializes booleans", () => {
    expect(canonicalJsonStringify(true)).toBe("true");
    expect(canonicalJsonStringify(false)).toBe("false");
  });

  it("serializes arrays preserving order", () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("serializes nested arrays", () => {
    expect(canonicalJsonStringify([[1], [2, 3]])).toBe("[[1],[2,3]]");
  });

  it("serializes objects with sorted keys", () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("serializes nested objects with sorted keys at every level", () => {
    const obj = { z: { b: 1, a: 2 }, a: { d: 3, c: 4 } };
    expect(canonicalJsonStringify(obj)).toBe('{"a":{"c":4,"d":3},"z":{"a":2,"b":1}}');
  });

  it("produces no whitespace", () => {
    const obj = { key: "value", nested: { inner: [1, 2] } };
    const result = canonicalJsonStringify(obj);
    expect(result).not.toMatch(/\s/);
  });

  it("handles empty objects and arrays", () => {
    expect(canonicalJsonStringify({})).toBe("{}");
    expect(canonicalJsonStringify([])).toBe("[]");
  });

  it("handles special characters in strings", () => {
    expect(canonicalJsonStringify({ key: 'val"ue' })).toBe('{"key":"val\\"ue"}');
  });

  it("matches the Matrix spec example structure", () => {
    // Simplified device keys object like what Matrix uses
    const obj = {
      user_id: "@alice:example.com",
      device_id: "JLAFKJWSCS",
      algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
      keys: {
        "curve25519:JLAFKJWSCS": "3C5BFWi2Y/0g0nSC8Ai2MhNGEyMNIcag87Fd+0HZ0yA",
        "ed25519:JLAFKJWSCS": "lEuiRJBit0IG6nUf5pUzWTQEI0sCbV4+9lq0Xhh99RI",
      },
    };
    const result = canonicalJsonStringify(obj);
    // Keys should be sorted: algorithms, device_id, keys, user_id
    expect(result).toMatch(/^\{"algorithms".*"device_id".*"keys".*"user_id"/);
    // Inner keys object should also be sorted
    expect(result).toContain('"curve25519:JLAFKJWSCS"');
    expect(result).toContain('"ed25519:JLAFKJWSCS"');
  });
});

describe("signDevice", () => {
  // Generate a real Ed25519 keypair for testing
  function generateEd25519Keypair(): { seed: Uint8Array; publicKeyBase64: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    // Extract the 32-byte seed from the private key PKCS8 DER
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    const seed = new Uint8Array(pkcs8).slice(-32);
    // Extract the 32-byte public key from SPKI DER
    const spki = publicKey.export({ format: "der", type: "spki" });
    const pubBytes = new Uint8Array(spki).slice(-32);
    const publicKeyBase64 = Buffer.from(pubBytes).toString("base64").replace(/=+$/, "");
    return { seed, publicKeyBase64 };
  }

  it("produces an Ed25519 signature that can be verified", () => {
    const { seed, publicKeyBase64 } = generateEd25519Keypair();
    const deviceKeys = {
      deviceId: "TESTDEVICE",
      userId: "@bot:example.com",
      ed25519Key: "ed25519pubkey",
      curve25519Key: "curve25519pubkey",
    };

    const { signature, keyId } = signDevice(deviceKeys, seed, publicKeyBase64);

    // Signature should be non-empty unpadded base64
    expect(signature.length).toBeGreaterThan(0);
    expect(signature).not.toContain("=");

    // Key ID should reference the public key
    expect(keyId).toBe(`ed25519:${publicKeyBase64}`);

    // Verify the signature using the public key
    const keysObj = {
      user_id: deviceKeys.userId,
      device_id: deviceKeys.deviceId,
      algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
      keys: {
        [`curve25519:${deviceKeys.deviceId}`]: deviceKeys.curve25519Key,
        [`ed25519:${deviceKeys.deviceId}`]: deviceKeys.ed25519Key,
      },
    };
    const canonical = canonicalJsonStringify(keysObj);

    // Rebuild public key from base64
    const pubKeyBytes = Buffer.from(publicKeyBase64, "base64");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spkiDer = Buffer.concat([spkiPrefix, pubKeyBytes]);
    const pubKeyObj = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });

    // Re-pad the signature for verification
    const sigBuf = Buffer.from(signature, "base64");
    const isValid = crypto.verify(null, Buffer.from(canonical), pubKeyObj, sigBuf);
    expect(isValid).toBe(true);
  });

  it("produces different signatures for different device keys", () => {
    const { seed, publicKeyBase64 } = generateEd25519Keypair();

    const result1 = signDevice(
      {
        deviceId: "DEV1",
        userId: "@u:x.com",
        ed25519Key: "key1",
        curve25519Key: "c1",
      },
      seed,
      publicKeyBase64,
    );
    const result2 = signDevice(
      {
        deviceId: "DEV2",
        userId: "@u:x.com",
        ed25519Key: "key2",
        curve25519Key: "c2",
      },
      seed,
      publicKeyBase64,
    );

    expect(result1.signature).not.toBe(result2.signature);
  });

  it("is deterministic for the same inputs", () => {
    const { seed, publicKeyBase64 } = generateEd25519Keypair();
    const keys = {
      deviceId: "DEV",
      userId: "@u:x.com",
      ed25519Key: "e",
      curve25519Key: "c",
    };

    const r1 = signDevice(keys, seed, publicKeyBase64);
    const r2 = signDevice(keys, seed, publicKeyBase64);
    // Ed25519 is deterministic (no random nonce)
    expect(r1.signature).toBe(r2.signature);
  });
});
