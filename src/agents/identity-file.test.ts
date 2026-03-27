import { describe, expect, it } from "vitest";
import { parseIdentityMarkdown } from "./identity-file.js";

describe("parseIdentityMarkdown", () => {
  it("ignores identity template placeholders", () => {
    const content = `
# IDENTITY.md - Who Am I?

- **Name:** *(pick something you like)*
- **Creature:** *(AI? robot? familiar? ghost in the machine? something weirder?)*
- **Vibe:** *(how do you come across? sharp? warm? chaotic? calm?)*
- **Emoji:** *(your signature - pick one that feels right)*
- **Avatar:** *(workspace-relative path, http(s) URL, or data URI)*
`;
    const parsed = parseIdentityMarkdown(content);
    expect(parsed).toEqual({});
  });

  it("parses explicit identity values", () => {
    const content = `
- **Name:** Samantha
- **Creature:** Robot
- **Vibe:** Warm
- **Emoji:** :robot:
- **Avatar:** avatars/openclaw.png
`;
    const parsed = parseIdentityMarkdown(content);
    expect(parsed).toEqual({
      name: "Samantha",
      creature: "Robot",
      vibe: "Warm",
      emoji: ":robot:",
      avatar: "avatars/openclaw.png",
    });
  });

  describe("capabilities parsing", () => {
    it("parses comma-separated capabilities", () => {
      const content = "- name: TestBot\n- capabilities: code, testing, ui";
      const parsed = parseIdentityMarkdown(content);
      expect(parsed.capabilities).toEqual(["code", "testing", "ui"]);
    });

    it("parses single capability", () => {
      const content = "- capabilities: code";
      const parsed = parseIdentityMarkdown(content);
      expect(parsed.capabilities).toEqual(["code"]);
    });

    it("returns undefined capabilities when no capabilities line present", () => {
      const content = "- name: TestBot";
      const parsed = parseIdentityMarkdown(content);
      expect(parsed.capabilities).toBeUndefined();
    });

    it("returns undefined capabilities when capabilities value is empty", () => {
      const content = "- capabilities: ";
      const parsed = parseIdentityMarkdown(content);
      expect(parsed.capabilities).toBeUndefined();
    });

    it("parses capabilities alongside other fields", () => {
      const content = `- name: TestBot
- emoji: :robot:
- capabilities: code, testing
- vibe: chill`;
      const parsed = parseIdentityMarkdown(content);
      expect(parsed.name).toBe("TestBot");
      expect(parsed.emoji).toBe(":robot:");
      expect(parsed.capabilities).toEqual(["code", "testing"]);
      expect(parsed.vibe).toBe("chill");
    });
  });
});
