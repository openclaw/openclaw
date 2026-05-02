import { describe, expect, it } from "vitest";
import { sanitizeProfileIdForDisplay, validateProfileId } from "./sanitize.js";

describe("sanitizeProfileIdForDisplay", () => {
  it("passes through clean profile IDs unchanged", () => {
    expect(sanitizeProfileIdForDisplay("openai-codex:user")).toBe("openai-codex:user");
  });

  it("strips ANSI escape sequences", () => {
    expect(sanitizeProfileIdForDisplay("pre\x1b[31mred\x1b[0mpost")).toBe("preredpost");
  });

  it("strips C0 and C1 control characters", () => {
    expect(sanitizeProfileIdForDisplay("a\x00b\x1fc\x7fd\x9be")).toBe("abcde");
  });
});

describe("validateProfileId", () => {
  it("accepts simple alphanumeric IDs", () => {
    expect(validateProfileId("myprofile123")).toBeNull();
  });

  it("accepts IDs with dots, underscores, colons, and hyphens", () => {
    expect(validateProfileId("openai-codex:my_profile.v2")).toBeNull();
  });

  it("accepts IDs with @ and + (OAuth-generated profile IDs)", () => {
    expect(validateProfileId("openai-codex:user+alias@example.com")).toBeNull();
  });

  it("rejects empty IDs", () => {
    expect(validateProfileId("")).toBe("Profile ID must not be empty.");
  });

  it("rejects IDs longer than 128 characters", () => {
    const long = "a".repeat(129);
    expect(validateProfileId(long)).toBe(`Profile ID must be at most 128 characters (got 129).`);
  });

  it("rejects IDs with spaces", () => {
    expect(validateProfileId("has space")).toMatch(/may only contain/);
  });

  it("rejects IDs with shell metacharacters", () => {
    expect(validateProfileId("profile;rm -rf /")).toMatch(/may only contain/);
  });

  it("rejects reserved object-property profile IDs", () => {
    expect(validateProfileId("__proto__")).toBe(
      "Profile ID '__proto__' is reserved and may not be used.",
    );
  });

  it("rejects IDs with ANSI escape sequences", () => {
    expect(validateProfileId("pre\x1b[31mred")).toMatch(/may only contain/);
  });
});
