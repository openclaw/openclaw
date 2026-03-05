/**
 * Tests for WecomCrypto (crypto.js)
 * Uses Node.js built-in node:test and node:assert only.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { WecomCrypto } from "../crypto.js";

// AES key must be exactly 43 chars (base64 without trailing '=').
// These produce a valid 32-byte AES key when base64-decoded with the appended '='.
const VALID_KEY = "aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkYWI"; // 43 chars
const VALID_TOKEN = "TestToken123";

describe("WecomCrypto — constructor validation", () => {
  it("throws when encodingAesKey is missing", () => {
    assert.throws(
      () => new WecomCrypto(VALID_TOKEN, undefined),
      /EncodingAESKey invalid/,
    );
  });

  it("throws when encodingAesKey is too short", () => {
    assert.throws(
      () => new WecomCrypto(VALID_TOKEN, "tooshort"),
      /EncodingAESKey invalid/,
    );
  });

  it("throws when encodingAesKey is too long", () => {
    assert.throws(
      () => new WecomCrypto(VALID_TOKEN, VALID_KEY + "X"),
      /EncodingAESKey invalid/,
    );
  });

  it("throws when token is empty string", () => {
    assert.throws(() => new WecomCrypto("", VALID_KEY), /Token is required/);
  });

  it("throws when token is null", () => {
    assert.throws(() => new WecomCrypto(null, VALID_KEY), /Token is required/);
  });

  it("constructs successfully with valid inputs", () => {
    const crypto = new WecomCrypto(VALID_TOKEN, VALID_KEY);
    assert.equal(crypto.token, VALID_TOKEN);
    assert.equal(crypto.encodingAesKey, VALID_KEY);
    assert.equal(crypto.aesKey.length, 32);
    assert.equal(crypto.iv.length, 16);
  });
});

describe("WecomCrypto — PKCS7 padding", () => {
  let crypto;
  before(() => {
    crypto = new WecomCrypto(VALID_TOKEN, VALID_KEY);
  });

  it("encodePkcs7 pads to a multiple of 32 bytes", () => {
    const input = Buffer.from("hello");
    const padded = crypto.encodePkcs7(input);
    assert.equal(padded.length % 32, 0);
    assert.ok(padded.length >= 32);
  });

  it("decodePkcs7 reverses encodePkcs7", () => {
    const input = Buffer.from("hello world test data");
    const padded = crypto.encodePkcs7(input);
    const decoded = crypto.decodePkcs7(padded);
    assert.deepEqual(decoded, input);
  });

  it("decodePkcs7 throws on invalid pad byte (0)", () => {
    // Craft a buffer with last byte = 0 (invalid PKCS7 pad).
    const buf = Buffer.alloc(32, 0x41);
    buf[31] = 0;
    assert.throws(() => crypto.decodePkcs7(buf), /Invalid PKCS7 padding/);
  });

  it("decodePkcs7 throws on pad value exceeding block size", () => {
    const buf = Buffer.alloc(32, 0x41);
    buf[31] = 33; // > AES_BLOCK_SIZE (32)
    assert.throws(() => crypto.decodePkcs7(buf), /Invalid PKCS7 padding/);
  });

  it("decodePkcs7 throws on inconsistent padding bytes", () => {
    // Last byte says pad=4 but the 3 bytes before it are not 4.
    const buf = Buffer.alloc(32, 0x41);
    buf[31] = 4;
    buf[30] = 3; // inconsistent
    buf[29] = 4;
    buf[28] = 4;
    assert.throws(
      () => crypto.decodePkcs7(buf),
      /Invalid PKCS7 padding: inconsistent/,
    );
  });
});

describe("WecomCrypto — encrypt / decrypt roundtrip", () => {
  let crypto;
  before(() => {
    crypto = new WecomCrypto(VALID_TOKEN, VALID_KEY);
  });

  it("encrypts and decrypts a simple ASCII string", () => {
    const plaintext = "Hello, WeCom!";
    const encrypted = crypto.encrypt(plaintext);
    assert.ok(typeof encrypted === "string");
    assert.ok(encrypted.length > 0);
    const { message } = crypto.decrypt(encrypted);
    assert.equal(message, plaintext);
  });

  it("encrypts and decrypts a JSON payload", () => {
    const payload = JSON.stringify({
      msgtype: "text",
      text: { content: "测试消息" },
    });
    const encrypted = crypto.encrypt(payload);
    const { message } = crypto.decrypt(encrypted);
    assert.equal(message, payload);
  });

  it("encrypts and decrypts a Chinese UTF-8 string", () => {
    const plaintext = "企业微信AI机器人测试消息，包含中文字符";
    const encrypted = crypto.encrypt(plaintext);
    const { message } = crypto.decrypt(encrypted);
    assert.equal(message, plaintext);
  });

  it("each encrypt call produces a different ciphertext (random IV component)", () => {
    const plaintext = "same message";
    const enc1 = crypto.encrypt(plaintext);
    const enc2 = crypto.encrypt(plaintext);
    // Random 16-byte prefix means ciphertexts differ.
    assert.notEqual(enc1, enc2);
    // But both decrypt correctly.
    assert.equal(crypto.decrypt(enc1).message, plaintext);
    assert.equal(crypto.decrypt(enc2).message, plaintext);
  });

  it("decrypt returns empty receiveid for AI Bot mode messages", () => {
    const encrypted = crypto.encrypt("test");
    const { receiveid } = crypto.decrypt(encrypted);
    // Encrypted with no corpId suffix, so receiveid is empty.
    assert.equal(receiveid, "");
  });
});

describe("WecomCrypto — getSignature", () => {
  let crypto;
  before(() => {
    crypto = new WecomCrypto(VALID_TOKEN, VALID_KEY);
  });

  it("returns a 40-char lowercase hex SHA1 digest", () => {
    const sig = crypto.getSignature("1234567890", "nonce123", "encryptedText");
    assert.match(sig, /^[0-9a-f]{40}$/);
  });

  it("is deterministic for the same inputs", () => {
    const sig1 = crypto.getSignature("ts", "nc", "enc");
    const sig2 = crypto.getSignature("ts", "nc", "enc");
    assert.equal(sig1, sig2);
  });

  it("differs when any input changes", () => {
    const base = crypto.getSignature("ts", "nc", "enc");
    assert.notEqual(crypto.getSignature("XX", "nc", "enc"), base);
    assert.notEqual(crypto.getSignature("ts", "XX", "enc"), base);
    assert.notEqual(crypto.getSignature("ts", "nc", "XX"), base);
  });
});

describe("WecomCrypto — validateReceiverId", () => {
  let crypto;
  before(() => {
    crypto = new WecomCrypto(VALID_TOKEN, VALID_KEY);
  });

  it("returns true when expectedCorpId is empty (AI Bot mode)", () => {
    assert.equal(crypto.validateReceiverId("ww1234", ""), true);
    assert.equal(crypto.validateReceiverId("anything", null), true);
    assert.equal(crypto.validateReceiverId("", ""), true);
  });

  it("returns true when receiveid matches expectedCorpId", () => {
    assert.equal(crypto.validateReceiverId("wwABCDE", "wwABCDE"), true);
  });

  it("returns false when receiveid does not match", () => {
    assert.equal(crypto.validateReceiverId("wwABCDE", "wwXXXXX"), false);
  });
});

describe("WecomCrypto — decryptMedia", () => {
  let crypto;
  before(() => {
    crypto = new WecomCrypto(VALID_TOKEN, VALID_KEY);
  });

  it("encrypts and decrypts a media buffer roundtrip", () => {
    // Simulate raw media bytes (non-PNG magic so smartDecrypt doesn't skip).
    const mediaContent = Buffer.from([
      0xaa,
      0xbb,
      0xcc,
      0xdd, // unknown magic — will be treated as encrypted
      ...Array.from({ length: 100 }, (_, i) => i % 256),
    ]);

    // Encrypt using AES-256-CBC without the message-length framing (pure media encrypt).
    const cipher = createCipheriv("aes-256-cbc", crypto.aesKey, crypto.iv);
    cipher.setAutoPadding(false);
    const padded = crypto.encodePkcs7(mediaContent);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

    const decrypted = crypto.decryptMedia(encrypted);
    assert.deepEqual(decrypted, mediaContent);
  });
});
