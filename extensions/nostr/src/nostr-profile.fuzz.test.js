import { describe, expect, it } from "vitest";
import {
  createProfileEvent,
  profileToContent,
  validateProfile,
  sanitizeProfileForDisplay
} from "./nostr-profile.js";
const TEST_HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_SK = new Uint8Array(TEST_HEX_KEY.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
describe("profile unicode attacks", () => {
  describe("zero-width characters", () => {
    it("handles zero-width space in name", () => {
      const profile = {
        name: "test\u200Buser"
        // Zero-width space
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
      expect(result.profile?.name).toBe("test\u200Buser");
    });
    it("handles zero-width joiner in name", () => {
      const profile = {
        name: "test\u200Duser"
        // Zero-width joiner
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
    it("handles zero-width non-joiner in about", () => {
      const profile = {
        about: "test\u200Cabout"
        // Zero-width non-joiner
      };
      const content = profileToContent(profile);
      expect(content.about).toBe("test\u200Cabout");
    });
  });
  describe("RTL override attacks", () => {
    it("handles RTL override in name", () => {
      const profile = {
        name: "\u202Eevil\u202C"
        // Right-to-left override + pop direction
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
      const sanitized = sanitizeProfileForDisplay(result.profile);
      expect(sanitized.name).toBeDefined();
    });
    it("handles bidi embedding in about", () => {
      const profile = {
        about: "Normal \u202Breversed\u202C text"
        // LTR embedding
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
  });
  describe("homoglyph attacks", () => {
    it("handles Cyrillic homoglyphs", () => {
      const profile = {
        // Cyrillic 'а' (U+0430) looks like Latin 'a'
        name: "\u0430dmin"
        // Fake "admin"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
    it("handles Greek homoglyphs", () => {
      const profile = {
        // Greek 'ο' (U+03BF) looks like Latin 'o'
        name: "b\u03BFt"
        // Looks like "bot"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
  });
  describe("combining characters", () => {
    it("handles combining diacritics", () => {
      const profile = {
        name: "cafe\u0301"
        // 'e' + combining acute = 'é'
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
      expect(result.profile?.name).toBe("cafe\u0301");
    });
    it("handles excessive combining characters (Zalgo text)", () => {
      const marks = "\u0301\u0300\u0336\u034F\u035C\u0360";
      const zalgo = `t${marks.repeat(256)}e${marks.repeat(256)}s${marks.repeat(256)}t`;
      const profile = {
        name: zalgo.slice(0, 256)
        // Truncate to fit limit
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
  });
  describe("CJK and other scripts", () => {
    it("handles Chinese characters", () => {
      const profile = {
        name: "\u4E2D\u6587\u7528\u6237",
        about: "\u6211\u662F\u4E00\u4E2A\u673A\u5668\u4EBA"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
    it("handles Japanese hiragana and katakana", () => {
      const profile = {
        name: "\u30DC\u30C3\u30C8",
        about: "\u3053\u308C\u306F\u30C6\u30B9\u30C8\u3067\u3059"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
    it("handles Korean characters", () => {
      const profile = {
        name: "\uD55C\uAD6D\uC5B4\uC0AC\uC6A9\uC790"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
    it("handles Arabic text", () => {
      const profile = {
        name: "\u0645\u0633\u062A\u062E\u062F\u0645",
        about: "\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
    it("handles Hebrew text", () => {
      const profile = {
        name: "\u05DE\u05E9\u05EA\u05DE\u05E9"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
    it("handles Thai text", () => {
      const profile = {
        name: "\u0E1C\u0E39\u0E49\u0E43\u0E0A\u0E49"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
  });
  describe("emoji edge cases", () => {
    it("handles emoji sequences (ZWJ)", () => {
      const profile = {
        name: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"
        // Family emoji using ZWJ
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
    it("handles flag emojis", () => {
      const profile = {
        name: "\u{1F1FA}\u{1F1F8}\u{1F1EF}\u{1F1F5}\u{1F1EC}\u{1F1E7}"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
    it("handles skin tone modifiers", () => {
      const profile = {
        name: "\u{1F44B}\u{1F3FB}\u{1F44B}\u{1F3FD}\u{1F44B}\u{1F3FF}"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(true);
    });
  });
});
describe("profile XSS attacks", () => {
  describe("script injection", () => {
    it("escapes script tags", () => {
      const profile = {
        name: '<script>alert("xss")</script>'
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.name).not.toContain("<script>");
      expect(sanitized.name).toContain("&lt;script&gt;");
    });
    it("escapes nested script tags", () => {
      const profile = {
        about: '<<script>script>alert("xss")<</script>/script>'
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.about).not.toContain("<script>");
    });
  });
  describe("event handler injection", () => {
    it("escapes img onerror", () => {
      const profile = {
        about: '<img src="x" onerror="alert(1)">'
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.about).toContain("&lt;img");
      expect(sanitized.about).not.toContain('onerror="alert');
    });
    it("escapes svg onload", () => {
      const profile = {
        about: '<svg onload="alert(1)">'
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.about).toContain("&lt;svg");
    });
    it("escapes body onload", () => {
      const profile = {
        about: '<body onload="alert(1)">'
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.about).toContain("&lt;body");
    });
  });
  describe("URL-based attacks", () => {
    it("rejects javascript: URL in picture", () => {
      const profile = {
        picture: "javascript:alert('xss')"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(false);
    });
    it("rejects javascript: URL with encoding", () => {
      const profile = {
        picture: "java&#115;cript:alert('xss')"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(false);
    });
    it("rejects data: URL", () => {
      const profile = {
        picture: "data:text/html,<script>alert('xss')</script>"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(false);
    });
    it("rejects vbscript: URL", () => {
      const profile = {
        website: "vbscript:msgbox('xss')"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(false);
    });
    it("rejects file: URL", () => {
      const profile = {
        picture: "file:///etc/passwd"
      };
      const result = validateProfile(profile);
      expect(result.valid).toBe(false);
    });
  });
  describe("HTML attribute injection", () => {
    it("escapes double quotes in fields", () => {
      const profile = {
        name: '" onclick="alert(1)" data-x="'
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.name).toContain("&quot;");
      expect(sanitized.name).not.toContain('onclick="alert');
    });
    it("escapes single quotes in fields", () => {
      const profile = {
        name: "' onclick='alert(1)' data-x='"
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.name).toContain("&#039;");
    });
  });
  describe("CSS injection", () => {
    it("escapes style tags", () => {
      const profile = {
        about: '<style>body{background:url("javascript:alert(1)")}</style>'
      };
      const sanitized = sanitizeProfileForDisplay(profile);
      expect(sanitized.about).toContain("&lt;style&gt;");
    });
  });
});
describe("profile length boundaries", () => {
  describe("name field (max 256)", () => {
    it("accepts exactly 256 characters", () => {
      const result = validateProfile({ name: "a".repeat(256) });
      expect(result.valid).toBe(true);
    });
    it("rejects 257 characters", () => {
      const result = validateProfile({ name: "a".repeat(257) });
      expect(result.valid).toBe(false);
    });
    it("accepts empty string", () => {
      const result = validateProfile({ name: "" });
      expect(result.valid).toBe(true);
    });
  });
  describe("displayName field (max 256)", () => {
    it("accepts exactly 256 characters", () => {
      const result = validateProfile({ displayName: "b".repeat(256) });
      expect(result.valid).toBe(true);
    });
    it("rejects 257 characters", () => {
      const result = validateProfile({ displayName: "b".repeat(257) });
      expect(result.valid).toBe(false);
    });
  });
  describe("about field (max 2000)", () => {
    it("accepts exactly 2000 characters", () => {
      const result = validateProfile({ about: "c".repeat(2e3) });
      expect(result.valid).toBe(true);
    });
    it("rejects 2001 characters", () => {
      const result = validateProfile({ about: "c".repeat(2001) });
      expect(result.valid).toBe(false);
    });
  });
  describe("URL fields", () => {
    it("accepts long valid HTTPS URLs", () => {
      const longPath = "a".repeat(1e3);
      const result = validateProfile({
        picture: `https://example.com/${longPath}.png`
      });
      expect(result.valid).toBe(true);
    });
    it("rejects invalid URL format", () => {
      const result = validateProfile({
        picture: "not-a-url"
      });
      expect(result.valid).toBe(false);
    });
    it("rejects URL without protocol", () => {
      const result = validateProfile({
        picture: "example.com/pic.png"
      });
      expect(result.valid).toBe(false);
    });
  });
});
describe("profile type confusion", () => {
  it("rejects number as name", () => {
    const result = validateProfile({ name: 123 });
    expect(result.valid).toBe(false);
  });
  it("rejects array as about", () => {
    const result = validateProfile({ about: ["hello"] });
    expect(result.valid).toBe(false);
  });
  it("rejects object as picture", () => {
    const result = validateProfile({
      picture: { url: "https://example.com" }
    });
    expect(result.valid).toBe(false);
  });
  it("rejects null as name", () => {
    const result = validateProfile({ name: null });
    expect(result.valid).toBe(false);
  });
  it("rejects boolean as about", () => {
    const result = validateProfile({ about: true });
    expect(result.valid).toBe(false);
  });
  it("rejects function as name", () => {
    const result = validateProfile({ name: (() => "test") });
    expect(result.valid).toBe(false);
  });
  it("handles prototype pollution attempt", () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}}');
    validateProfile(malicious);
    expect({}.polluted).toBeUndefined();
  });
});
describe("event creation edge cases", () => {
  it("handles profile with all fields at max length", () => {
    const profile = {
      name: "a".repeat(256),
      displayName: "b".repeat(256),
      about: "c".repeat(2e3),
      nip05: "d".repeat(200) + "@example.com",
      lud16: "e".repeat(200) + "@example.com"
    };
    const event = createProfileEvent(TEST_SK, profile);
    expect(event.kind).toBe(0);
    expect(() => JSON.parse(event.content)).not.toThrow();
  });
  it("handles rapid sequential events with monotonic timestamps", () => {
    const profile = { name: "rapid" };
    let lastTimestamp = 0;
    for (let i = 0; i < 25; i++) {
      const event = createProfileEvent(TEST_SK, profile, lastTimestamp);
      expect(event.created_at).toBeGreaterThan(lastTimestamp);
      lastTimestamp = event.created_at;
    }
  });
  it("handles JSON special characters in content", () => {
    const profile = {
      name: 'test"user',
      about: "line1\nline2	tab\\backslash"
    };
    const event = createProfileEvent(TEST_SK, profile);
    const parsed = JSON.parse(event.content);
    expect(parsed.name).toBe('test"user');
    expect(parsed.about).toContain("\n");
    expect(parsed.about).toContain("	");
    expect(parsed.about).toContain("\\");
  });
});
