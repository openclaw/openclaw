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

  it("preserves the arbitrary-key contract: accepts spaces and other characters", () => {
    // Auth profile IDs are arbitrary string keys; pre-existing IDs with spaces
    // or punctuation must remain targetable from the CLI.
    expect(validateProfileId("has space")).toBeNull();
    expect(validateProfileId("profile;weird&chars")).toBeNull();
    expect(validateProfileId("legacy/id.with-slashes")).toBeNull();
  });

  it("rejects empty IDs", () => {
    expect(validateProfileId("")).toBe("Profile ID must not be empty.");
  });

  it("rejects pathologically long IDs (over 512 chars)", () => {
    const long = "a".repeat(513);
    expect(validateProfileId(long)).toBe(`Profile ID must be at most 512 characters (got 513).`);
  });

  it("accepts realistic long IDs (over the old 128 cap)", () => {
    // Regression: the old 128-char grammar broke existing longer IDs.
    expect(validateProfileId("openai-codex:" + "x".repeat(150))).toBeNull();
  });

  it("rejects reserved object-property profile IDs", () => {
    expect(validateProfileId("__proto__")).toBe(
      "Profile ID '__proto__' is reserved and may not be used.",
    );
  });

  it("rejects IDs with control characters (terminal/log injection)", () => {
    expect(validateProfileId("pre\x1b[31mred")).toMatch(/control or escape characters/);
    expect(validateProfileId("line\nbreak")).toMatch(/control or escape characters/);
    expect(validateProfileId("nul\x00byte")).toMatch(/control or escape characters/);
  });
});
