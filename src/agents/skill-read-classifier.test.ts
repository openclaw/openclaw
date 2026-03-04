import type { Skill } from "@mariozechner/pi-coding-agent";
import { describe, it, expect } from "vitest";
import { classifySkillRead } from "./skill-read-classifier.js";

const testSkills: Skill[] = [
  {
    name: "github",
    description: "GitHub operations",
    filePath: "/home/user/.openclaw/skills/github/SKILL.md",
    baseDir: "/home/user/.openclaw/skills/github",
    source: "workspace",
    disableModelInvocation: false,
  },
  {
    name: "weather",
    description: "Weather forecasts",
    filePath: "/home/user/workspace/skills/weather/SKILL.md",
    baseDir: "/home/user/workspace/skills/weather",
    source: "workspace",
    disableModelInvocation: false,
  },
];

describe("classifySkillRead", () => {
  it("detects SKILL.md as entry read", () => {
    const result = classifySkillRead("/home/user/.openclaw/skills/github/SKILL.md", testSkills);
    expect(result.isSkillRead).toBe(true);
    if (result.isSkillRead) {
      expect(result.skillName).toBe("github");
      expect(result.readType).toBe("entry");
    }
  });

  it("detects sub-file as sub read", () => {
    const result = classifySkillRead(
      "/home/user/.openclaw/skills/github/references/api.md",
      testSkills,
    );
    expect(result.isSkillRead).toBe(true);
    if (result.isSkillRead) {
      expect(result.skillName).toBe("github");
      expect(result.readType).toBe("sub");
    }
  });

  it("expands ~ to home directory", () => {
    const result = classifySkillRead(
      "~/.openclaw/skills/github/SKILL.md",
      testSkills,
      "/home/user",
    );
    expect(result.isSkillRead).toBe(true);
    if (result.isSkillRead) {
      expect(result.skillName).toBe("github");
      expect(result.readType).toBe("entry");
    }
  });

  it("returns false for non-skill paths", () => {
    const result = classifySkillRead("/home/user/random/file.md", testSkills);
    expect(result.isSkillRead).toBe(false);
  });

  it("returns false for empty skills list", () => {
    const result = classifySkillRead("/home/user/.openclaw/skills/github/SKILL.md", []);
    expect(result.isSkillRead).toBe(false);
  });

  it("handles different skill directories correctly", () => {
    const result = classifySkillRead(
      "/home/user/workspace/skills/weather/scripts/fetch.sh",
      testSkills,
    );
    expect(result.isSkillRead).toBe(true);
    if (result.isSkillRead) {
      expect(result.skillName).toBe("weather");
      expect(result.readType).toBe("sub");
    }
  });
});
