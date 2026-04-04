import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt } from "./skills/skill-contract.js";

describe("available_skills visibility", () => {
  it("keeps a normal runnable skill visible in available_skills", () => {
    const prompt = formatSkillsForPrompt([
      {
        name: "demo-skill",
        description: "demo desc",
        filePath: "/tmp/demo/SKILL.md",
        content: "# demo",
        baseDir: "/tmp/demo",
        disableModelInvocation: false,
      },
    ]);

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>demo-skill</name>");
  });

  it("keeps formatter behavior explicit and does not hide disableModelInvocation skills by itself", () => {
    const prompt = formatSkillsForPrompt([
      {
        name: "hidden-skill",
        description: "hidden desc",
        filePath: "/tmp/hidden/SKILL.md",
        content: "# hidden",
        baseDir: "/tmp/hidden",
        disableModelInvocation: true,
      },
    ]);

    expect(prompt).toContain("<name>hidden-skill</name>");
  });
});
