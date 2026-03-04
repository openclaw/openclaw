import { describe, expect, it } from "vitest";
import { parseSkillRepoUrl } from "./skills-add-from-url.js";

describe("skills-add-from-url", () => {
  describe("parseSkillRepoUrl", () => {
    it("accepts https URL and returns repo name without .git", () => {
      expect(parseSkillRepoUrl("https://github.com/foo/bar")).toEqual({
        url: "https://github.com/foo/bar",
        name: "bar",
      });
      expect(parseSkillRepoUrl("https://github.com/org/my-skill.git")).toEqual({
        url: "https://github.com/org/my-skill.git",
        name: "my-skill",
      });
    });

    it("allows non-ASCII and emoji in repo name (blocklist validation)", () => {
      expect(parseSkillRepoUrl("https://github.com/user/技能")).toEqual({
        url: "https://github.com/user/技能",
        name: "技能",
      });
      expect(parseSkillRepoUrl("https://github.com/user/スキル")).toEqual({
        url: "https://github.com/user/スキル",
        name: "スキル",
      });
      expect(parseSkillRepoUrl("https://github.com/user/my-skill-🎉")).toEqual({
        url: "https://github.com/user/my-skill-🎉",
        name: "my-skill-🎉",
      });
    });

    it("rejects empty URL", () => {
      expect(() => parseSkillRepoUrl("")).toThrow("URL is required");
      expect(() => parseSkillRepoUrl("   ")).toThrow("URL is required");
    });

    it("rejects non-https URL", () => {
      expect(() => parseSkillRepoUrl("http://github.com/foo/bar")).toThrow(
        "Only https URLs are allowed",
      );
      expect(() => parseSkillRepoUrl("ssh://git@github.com/foo/bar")).toThrow(
        "Only https URLs are allowed",
      );
    });

    it("rejects repo name containing .. (blocklist)", () => {
      expect(() => parseSkillRepoUrl("https://github.com/foo/bar..baz")).toThrow(
        /Invalid repo name: must not contain/,
      );
      expect(() => parseSkillRepoUrl("https://github.com/foo/..")).toThrow(
        /Invalid repo name: must not contain/,
      );
    });

    it("rejects empty derived name", () => {
      expect(() => parseSkillRepoUrl("https://github.com/")).toThrow(
        /Invalid repo name: must not contain.*\(empty\)/,
      );
    });
  });
});
