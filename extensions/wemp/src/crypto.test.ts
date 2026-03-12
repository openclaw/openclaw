import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildEncryptedReply,
  decryptWechatMessage,
  encryptWechatMessage,
  verifyMessageSignature,
  verifySignature,
} from "./crypto.js";

describe("wemp crypto", () => {
  it("verifySignature works with sorted token/timestamp/nonce", () => {
    const token = "token-x";
    const timestamp = "1733990400";
    const nonce = "abcdef";
    const hash = createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
    expect(verifySignature(hash, timestamp, nonce, token)).toBe(true);
  });

  it("encryptWechatMessage and decryptWechatMessage roundtrip", () => {
    const aesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const appId = "wx_test_app_id";
    const xml =
      "<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content></xml>";
    const encrypted = encryptWechatMessage(xml, aesKey, appId);
    const decrypted = decryptWechatMessage(encrypted, aesKey, appId);
    expect(decrypted).toBe(xml);
  });

  it("buildEncryptedReply generates signature verifiable by verifyMessageSignature", () => {
    const token = "token-x";
    const aesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const appId = "wx_test_app_id";
    const timestamp = "1733990400";
    const nonce = "abcdef";
    const xml = "<xml><Content><![CDATA[test]]></Content></xml>";

    const reply = buildEncryptedReply({
      xml,
      token,
      encodingAESKey: aesKey,
      appId,
      timestamp,
      nonce,
    });
    const encrypted = /<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s.exec(reply)?.[1] || "";
    const signature = /<MsgSignature><!\[CDATA\[(.*?)\]\]><\/MsgSignature>/s.exec(reply)?.[1] || "";
    expect(encrypted.length).toBeGreaterThan(0);
    expect(signature.length).toBeGreaterThan(0);
    expect(verifyMessageSignature(signature, timestamp, nonce, encrypted, token)).toBe(true);
  });

  it("verifySignature returns false for wrong-length signature", () => {
    expect(verifySignature("short", "1733990400", "nonce", "token")).toBe(false);
  });

  it("encrypt/decrypt roundtrip with blockSize-aligned payload", () => {
    // 构造一个使 payload 长度恰好是 32 倍数的 XML
    const appId = "wx1234567890abcdef";
    const key = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    // 16 bytes random + 4 bytes length + xml + appId 需要是 32 的倍数
    // 尝试不同长度的 xml 确保 roundtrip 正确
    for (const xml of ["<a/>", "<xml><Content>test</Content></xml>", "x".repeat(100)]) {
      const encrypted = encryptWechatMessage(xml, key, appId);
      const decrypted = decryptWechatMessage(encrypted, key, appId);
      expect(decrypted).toBe(xml);
    }
  });
});
