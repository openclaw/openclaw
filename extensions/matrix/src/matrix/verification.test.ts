import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { __testing } from "./verification.js";

const {
  canonicalJson,
  computeCommitment,
  deriveMacKey,
  deriveSasBytes,
  deriveSasInfo,
  formatDecimalSas,
  formatEmojiSas,
  hmacSha256Base64,
} = __testing;

describe("matrix verification helpers", () => {
  it("canonicalJson sorts keys and omits whitespace", () => {
    const input = {
      b: 1,
      a: 2,
      nested: { z: "last", y: "first" },
      arr: ["x", "y"],
    };
    expect(canonicalJson(input)).toBe(
      '{"a":2,"arr":["x","y"],"b":1,"nested":{"y":"first","z":"last"}}',
    );
  });

  it("computeCommitment matches sha256(key || canonicalStart)", () => {
    const startContent: Parameters<typeof computeCommitment>[0]["startContent"] = {
      transaction_id: "t",
      hashes: ["sha256"],
      method: "m.sas.v1",
      from_device: "DEVICE",
      key_agreement_protocols: ["curve25519-hkdf-sha256"],
      message_authentication_codes: ["hkdf-hmac-sha256.v2"],
      short_authentication_string: ["emoji", "decimal"],
    };

    const canonicalStart =
      '{"from_device":"DEVICE","hashes":["sha256"],"key_agreement_protocols":["curve25519-hkdf-sha256"],"message_authentication_codes":["hkdf-hmac-sha256.v2"],"method":"m.sas.v1","short_authentication_string":["emoji","decimal"],"transaction_id":"t"}';
    expect(canonicalJson(startContent)).toBe(canonicalStart);

    const acceptorKeyBase64 = "abc";
    const expected = crypto
      .createHash("sha256")
      .update(acceptorKeyBase64 + canonicalStart, "utf8")
      .digest("base64")
      .replace(/=+$/g, "");

    expect(
      computeCommitment({
        acceptorKeyBase64,
        startContent,
      }),
    ).toBe(expected);
  });

  it("formats decimal + emoji SAS deterministically", () => {
    expect(formatDecimalSas(Buffer.alloc(5, 0))).toBe("1000 1000 1000");
    expect(formatDecimalSas(Buffer.from([0, 1, 2, 3, 4]))).toBe("1000 2032 1386");
    expect(formatEmojiSas(Buffer.alloc(6, 0))).toBe(
      "🐶 Dog | 🐶 Dog | 🐶 Dog | 🐶 Dog | 🐶 Dog | 🐶 Dog | 🐶 Dog",
    );
  });

  it("accepts HKDF output even when runtime returns ArrayBuffer", () => {
    const sharedSecret = Buffer.alloc(32, 7);
    const info = "MATRIX_KEY_VERIFICATION_SAS|@a:hs|A|k1|@b:hs|B|k2|txn";
    const derived = deriveSasBytes(sharedSecret, info, 6);
    const arrayBuffer = new ArrayBuffer(derived.byteLength);
    new Uint8Array(arrayBuffer).set(derived);

    expect(() => formatEmojiSas(arrayBuffer)).not.toThrow();
  });

  it("builds SAS info with | separators", () => {
    expect(
      deriveSasInfo({
        startUserId: "@a:hs",
        startDeviceId: "AAA",
        acceptUserId: "@b:hs",
        acceptDeviceId: "BBB",
        startPublicKeyBase64: "k1",
        acceptPublicKeyBase64: "k2",
        transactionId: "t",
      }),
    ).toBe("MATRIX_KEY_VERIFICATION_SAS|@a:hs|AAA|k1|@b:hs|BBB|k2|t");
  });

  it("supports padded and unpadded MAC output", () => {
    const sharedSecret = Buffer.alloc(32, 1);
    const key = deriveMacKey({
      sharedSecret,
      myUserId: "@a:hs",
      myDeviceId: "AAA",
      otherUserId: "@b:hs",
      otherDeviceId: "BBB",
      transactionId: "t",
      keyId: "ed25519:AAA",
    });

    const padded = hmacSha256Base64({ key, value: "abc", unpadded: false });
    const unpadded = hmacSha256Base64({ key, value: "abc", unpadded: true });

    expect(padded.endsWith("=")).toBe(true);
    expect(unpadded.endsWith("=")).toBe(false);
    expect(unpadded).toBe(padded.replace(/=+$/g, ""));
  });
});
