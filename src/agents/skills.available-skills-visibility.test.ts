import { describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import { formatSkillsForPrompt } from "./skills/skill-contract.js";

describe("available_skills visibility", () => {
  it("keeps a normal runnable skill visible in available_skills", () => {
    const prompt = formatSkillsForPrompt([
      createCanonicalFixtureSkill({
        name: "demo-skill",
        description: "demo desc",
        filePath: "/tmp/demo/SKILL.md",
        baseDir: "/tmp/demo",
        source: "workspace",
      }),
    ]);

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>demo-skill</name>");
  });

  it("keeps formatter behavior explicit and does not hide disableModelInvocation skills by itself", () => {
    const prompt = formatSkillsForPrompt([
      createCanonicalFixtureSkill({
        name: "hidden-skill",
        description: "hidden desc",
        filePath: "/tmp/hidden/SKILL.md",
        baseDir: "/tmp/hidden",
        source: "workspace",
        disableModelInvocation: true,
      }),
    ]);

    expect(prompt).toContain("<name>hidden-skill</name>");
  });
});
