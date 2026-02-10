import { describe, expect, it } from "vitest";

import { computeWecomMsgSignature, decryptWecomEncrypted, encryptWecomPlaintext } from "./crypto/index.js";

describe("wecom crypto", () => {
  it("round-trips plaintext", () => {
    const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43 chars base64 (plus '=' padding)
    const plaintext = JSON.stringify({ hello: "world" });
    const encrypt = encryptWecomPlaintext({ encodingAESKey, receiveId: "", plaintext });
    const decrypted = decryptWecomEncrypted({ encodingAESKey, receiveId: "", encrypt });
    expect(decrypted).toBe(plaintext);
  });

  it("pads correctly when raw length is a multiple of 32", () => {
    const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    // raw length = 20 + plaintext.length + receiveId.length; choose plaintext length % 32 === 12
    const plaintext = "x".repeat(12);
    const encrypt = encryptWecomPlaintext({ encodingAESKey, receiveId: "", plaintext });
    const decrypted = decryptWecomEncrypted({ encodingAESKey, receiveId: "", encrypt });
    expect(decrypted).toBe(plaintext);
  });

  it("computes sha1 msg signature", () => {
    const sig = computeWecomMsgSignature({
      token: "token",
      timestamp: "123",
      nonce: "456",
      encrypt: "ENCRYPT",
    });
    expect(sig).toMatch(/^[a-f0-9]{40}$/);
  });
});
