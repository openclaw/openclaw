import { verifyEvent, getPublicKey } from "nostr-tools";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createProfileEvent,
  profileToContent,
  contentToProfile,
  validateProfile,
  sanitizeProfileForDisplay
} from "./nostr-profile.js";
const TEST_HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_SK = new Uint8Array(TEST_HEX_KEY.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
const TEST_PUBKEY = getPublicKey(TEST_SK);
describe("profileToContent", () => {
  it("converts full profile to NIP-01 content format", () => {
    const profile = {
      name: "testuser",
      displayName: "Test User",
      about: "A test user for unit testing",
      picture: "https://example.com/avatar.png",
      banner: "https://example.com/banner.png",
      website: "https://example.com",
      nip05: "testuser@example.com",
      lud16: "testuser@walletofsatoshi.com"
    };
    const content = profileToContent(profile);
    expect(content.name).toBe("testuser");
    expect(content.display_name).toBe("Test User");
    expect(content.about).toBe("A test user for unit testing");
    expect(content.picture).toBe("https://example.com/avatar.png");
    expect(content.banner).toBe("https://example.com/banner.png");
    expect(content.website).toBe("https://example.com");
    expect(content.nip05).toBe("testuser@example.com");
    expect(content.lud16).toBe("testuser@walletofsatoshi.com");
  });
  it("omits undefined fields from content", () => {
    const profile = {
      name: "minimaluser"
    };
    const content = profileToContent(profile);
    expect(content.name).toBe("minimaluser");
    expect("display_name" in content).toBe(false);
    expect("about" in content).toBe(false);
    expect("picture" in content).toBe(false);
  });
  it("handles empty profile", () => {
    const profile = {};
    const content = profileToContent(profile);
    expect(Object.keys(content)).toHaveLength(0);
  });
});
describe("contentToProfile", () => {
  it("converts NIP-01 content to profile format", () => {
    const content = {
      name: "testuser",
      display_name: "Test User",
      about: "A test user",
      picture: "https://example.com/avatar.png",
      nip05: "test@example.com"
    };
    const profile = contentToProfile(content);
    expect(profile.name).toBe("testuser");
    expect(profile.displayName).toBe("Test User");
    expect(profile.about).toBe("A test user");
    expect(profile.picture).toBe("https://example.com/avatar.png");
    expect(profile.nip05).toBe("test@example.com");
  });
  it("handles empty content", () => {
    const content = {};
    const profile = contentToProfile(content);
    expect(
      Object.keys(profile).filter((k) => profile[k] !== void 0)
    ).toHaveLength(0);
  });
  it("round-trips profile data", () => {
    const original = {
      name: "roundtrip",
      displayName: "Round Trip Test",
      about: "Testing round-trip conversion"
    };
    const content = profileToContent(original);
    const restored = contentToProfile(content);
    expect(restored.name).toBe(original.name);
    expect(restored.displayName).toBe(original.displayName);
    expect(restored.about).toBe(original.about);
  });
});
describe("createProfileEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(/* @__PURE__ */ new Date("2024-01-15T12:00:00Z"));
  });
  it("creates a valid kind:0 event", () => {
    const profile = {
      name: "testbot",
      about: "A test bot"
    };
    const event = createProfileEvent(TEST_SK, profile);
    expect(event.kind).toBe(0);
    expect(event.pubkey).toBe(TEST_PUBKEY);
    expect(event.tags).toEqual([]);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
  });
  it("includes profile content as JSON in event content", () => {
    const profile = {
      name: "jsontest",
      displayName: "JSON Test User",
      about: "Testing JSON serialization"
    };
    const event = createProfileEvent(TEST_SK, profile);
    const parsedContent = JSON.parse(event.content);
    expect(parsedContent.name).toBe("jsontest");
    expect(parsedContent.display_name).toBe("JSON Test User");
    expect(parsedContent.about).toBe("Testing JSON serialization");
  });
  it("produces a verifiable signature", () => {
    const profile = { name: "signaturetest" };
    const event = createProfileEvent(TEST_SK, profile);
    expect(verifyEvent(event)).toBe(true);
  });
  it("uses current timestamp when no lastPublishedAt provided", () => {
    const profile = { name: "timestamptest" };
    const event = createProfileEvent(TEST_SK, profile);
    const expectedTimestamp = Math.floor(Date.now() / 1e3);
    expect(event.created_at).toBe(expectedTimestamp);
  });
  it("ensures monotonic timestamp when lastPublishedAt is in the future", () => {
    const futureTimestamp = 170532e4 + 3600;
    const profile = { name: "monotonictest" };
    const event = createProfileEvent(TEST_SK, profile, futureTimestamp);
    expect(event.created_at).toBe(futureTimestamp + 1);
  });
  it("uses current time when lastPublishedAt is in the past", () => {
    const pastTimestamp = 170532e4 - 3600;
    const profile = { name: "pasttest" };
    const event = createProfileEvent(TEST_SK, profile, pastTimestamp);
    const expectedTimestamp = Math.floor(Date.now() / 1e3);
    expect(event.created_at).toBe(expectedTimestamp);
  });
  vi.useRealTimers();
});
describe("validateProfile", () => {
  it("validates a correct profile", () => {
    const profile = {
      name: "validuser",
      about: "A valid user",
      picture: "https://example.com/pic.png"
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(true);
    expect(result.profile).toBeDefined();
    expect(result.errors).toBeUndefined();
  });
  it("rejects profile with invalid URL", () => {
    const profile = {
      name: "invalidurl",
      picture: "http://insecure.example.com/pic.png"
      // HTTP not HTTPS
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors.some((e) => e.includes("https://"))).toBe(true);
  });
  it("rejects profile with javascript: URL", () => {
    const profile = {
      name: "xssattempt",
      picture: "javascript:alert('xss')"
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
  });
  it("rejects profile with data: URL", () => {
    const profile = {
      name: "dataurl",
      picture: "data:image/png;base64,abc123"
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
  });
  it("rejects name exceeding 256 characters", () => {
    const profile = {
      name: "a".repeat(257)
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("256"))).toBe(true);
  });
  it("rejects about exceeding 2000 characters", () => {
    const profile = {
      about: "a".repeat(2001)
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("2000"))).toBe(true);
  });
  it("accepts empty profile", () => {
    const result = validateProfile({});
    expect(result.valid).toBe(true);
  });
  it("rejects null input", () => {
    const result = validateProfile(null);
    expect(result.valid).toBe(false);
  });
  it("rejects non-object input", () => {
    const result = validateProfile("not an object");
    expect(result.valid).toBe(false);
  });
});
describe("sanitizeProfileForDisplay", () => {
  it("escapes HTML in name field", () => {
    const profile = {
      name: "<script>alert('xss')</script>"
    };
    const sanitized = sanitizeProfileForDisplay(profile);
    expect(sanitized.name).toBe("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;");
  });
  it("escapes HTML in about field", () => {
    const profile = {
      about: 'Check out <img src="x" onerror="alert(1)">'
    };
    const sanitized = sanitizeProfileForDisplay(profile);
    expect(sanitized.about).toBe(
      "Check out &lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;"
    );
  });
  it("preserves URLs without modification", () => {
    const profile = {
      picture: "https://example.com/pic.png",
      website: "https://example.com"
    };
    const sanitized = sanitizeProfileForDisplay(profile);
    expect(sanitized.picture).toBe("https://example.com/pic.png");
    expect(sanitized.website).toBe("https://example.com");
  });
  it("handles undefined fields", () => {
    const profile = {
      name: "test"
    };
    const sanitized = sanitizeProfileForDisplay(profile);
    expect(sanitized.name).toBe("test");
    expect(sanitized.about).toBeUndefined();
    expect(sanitized.picture).toBeUndefined();
  });
  it("escapes ampersands", () => {
    const profile = {
      name: "Tom & Jerry"
    };
    const sanitized = sanitizeProfileForDisplay(profile);
    expect(sanitized.name).toBe("Tom &amp; Jerry");
  });
  it("escapes quotes", () => {
    const profile = {
      about: 'Say "hello" to everyone'
    };
    const sanitized = sanitizeProfileForDisplay(profile);
    expect(sanitized.about).toBe("Say &quot;hello&quot; to everyone");
  });
});
describe("edge cases", () => {
  it("handles emoji in profile fields", () => {
    const profile = {
      name: "\u{1F916} Bot",
      about: "I am a \u{1F916} robot! \u{1F389}"
    };
    const content = profileToContent(profile);
    expect(content.name).toBe("\u{1F916} Bot");
    expect(content.about).toBe("I am a \u{1F916} robot! \u{1F389}");
    const event = createProfileEvent(TEST_SK, profile);
    const parsed = JSON.parse(event.content);
    expect(parsed.name).toBe("\u{1F916} Bot");
  });
  it("handles unicode in profile fields", () => {
    const profile = {
      name: "\u65E5\u672C\u8A9E\u30E6\u30FC\u30B6\u30FC",
      about: "\u041F\u0440\u0438\u0432\u0435\u0442 \u043C\u0438\u0440! \u4F60\u597D\u4E16\u754C!"
    };
    const content = profileToContent(profile);
    expect(content.name).toBe("\u65E5\u672C\u8A9E\u30E6\u30FC\u30B6\u30FC");
    const event = createProfileEvent(TEST_SK, profile);
    expect(verifyEvent(event)).toBe(true);
  });
  it("handles newlines in about field", () => {
    const profile = {
      about: "Line 1\nLine 2\nLine 3"
    };
    const content = profileToContent(profile);
    expect(content.about).toBe("Line 1\nLine 2\nLine 3");
    const event = createProfileEvent(TEST_SK, profile);
    const parsed = JSON.parse(event.content);
    expect(parsed.about).toBe("Line 1\nLine 2\nLine 3");
  });
  it("handles maximum length fields", () => {
    const profile = {
      name: "a".repeat(256),
      about: "b".repeat(2e3)
    };
    const result = validateProfile(profile);
    expect(result.valid).toBe(true);
    const event = createProfileEvent(TEST_SK, profile);
    expect(verifyEvent(event)).toBe(true);
  });
});
