import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  _extractDedupeKey,
  _isDuplicateMessage,
  _base64UrlSafeDecode,
  _decryptMessage,
  _parseXmlMessage,
  _resetMessageCache,
  recordSentMessageId,
} from "./infoflow-req-parse.js";

// ---------------------------------------------------------------------------
// AES test helpers
// ---------------------------------------------------------------------------

function aesEcbEncrypt(plaintext: string, keyBytes: Buffer): string {
  const algo =
    keyBytes.length === 16 ? "aes-128-ecb" : keyBytes.length === 24 ? "aes-192-ecb" : "aes-256-ecb";
  const cipher = createCipheriv(algo, keyBytes, null);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return toUrlSafeBase64(encrypted);
}

function toUrlSafeBase64(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const KEY_32 = Buffer.from("0123456789abcdef0123456789abcdef"); // 32 bytes → AES-256

// ============================================================================
// extractDedupeKey
// ============================================================================

describe("extractDedupeKey", () => {
  it("returns header.messageid when present", () => {
    expect(_extractDedupeKey({ message: { header: { messageid: "msg-001" } } })).toBe("msg-001");
  });

  it("builds composite key from fromuserid + groupid + ctime", () => {
    expect(
      _extractDedupeKey({
        message: { header: { fromuserid: "user1", groupid: "g1", ctime: 12345 } },
      }),
    ).toBe("user1_g1_12345");
  });

  it("Date.now() fallback when ctime is missing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
    try {
      const key = _extractDedupeKey({ message: { header: { fromuserid: "user1" } } });
      expect(key).toBe(`user1_dm_${Date.now()}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when no extractable data", () => {
    expect(_extractDedupeKey({})).toBeNull();
  });
});

// ============================================================================
// isDuplicateMessage
// ============================================================================

describe("isDuplicateMessage", () => {
  beforeEach(() => {
    _resetMessageCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first-seen → false, duplicate → true", () => {
    const msg = { message: { header: { messageid: "msg-1" } } };
    expect(_isDuplicateMessage(msg)).toBe(false);
    expect(_isDuplicateMessage(msg)).toBe(true);
  });

  it("returns false after TTL expires", () => {
    const msg = { message: { header: { messageid: "msg-1" } } };
    _isDuplicateMessage(msg);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(_isDuplicateMessage(msg)).toBe(false);
  });

  it("recordSentMessageId prevents echo-back", () => {
    recordSentMessageId("sent-1");
    expect(_isDuplicateMessage({ message: { header: { messageid: "sent-1" } } })).toBe(true);
  });
});

// ============================================================================
// base64UrlSafeDecode
// ============================================================================

describe("base64UrlSafeDecode", () => {
  it("decodes URL-safe characters (- and _)", () => {
    const original = Buffer.from([0xfb, 0xef, 0xbe]);
    const urlSafe = original
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(_base64UrlSafeDecode(urlSafe)).toEqual(original);
  });

  it("auto-pads missing = characters", () => {
    expect(_base64UrlSafeDecode("SGVsbG8").toString("utf8")).toBe("Hello");
  });
});

// ============================================================================
// decryptMessage
// ============================================================================

describe("decryptMessage", () => {
  it("round-trips AES-256-ECB", () => {
    const plaintext = '{"fromuser":"bob","content":"hi"}';
    const encrypted = aesEcbEncrypt(plaintext, KEY_32);
    expect(_decryptMessage(encrypted, toUrlSafeBase64(KEY_32))).toBe(plaintext);
  });

  it("throws on invalid key length", () => {
    const badKey = Buffer.alloc(15, 0x41);
    const encrypted = aesEcbEncrypt("test", KEY_32);
    expect(() => _decryptMessage(encrypted, toUrlSafeBase64(badKey))).toThrow(
      /Invalid AES key length/,
    );
  });

  it("round-trips Unicode content", () => {
    const plaintext = "你好世界 🌍";
    const encrypted = aesEcbEncrypt(plaintext, KEY_32);
    expect(_decryptMessage(encrypted, toUrlSafeBase64(KEY_32))).toBe(plaintext);
  });
});

// ============================================================================
// parseXmlMessage
// ============================================================================

describe("parseXmlMessage", () => {
  it("parses simple XML tags", () => {
    expect(_parseXmlMessage("<xml><Name>test</Name></xml>")).toEqual({ Name: "test" });
  });

  it("parses CDATA sections", () => {
    expect(_parseXmlMessage("<xml><Content><![CDATA[hello world]]></Content></xml>")).toEqual({
      Content: "hello world",
    });
  });

  it("returns null for empty string", () => {
    expect(_parseXmlMessage("")).toBeNull();
  });

  it("handles CDATA containing XML-like content", () => {
    expect(_parseXmlMessage("<xml><Content><![CDATA[<b>bold</b>]]></Content></xml>")).toEqual({
      Content: "<b>bold</b>",
    });
  });
});
