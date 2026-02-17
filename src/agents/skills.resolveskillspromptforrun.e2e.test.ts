import { describe, expect, it } from "vitest";
import type { SkillEntry } from "./skills.js";
import { resolveSkillsPromptForRun } from "./skills.js";
import type { SkillEntry } from "./skills/types.js";

describe("resolveSkillsPromptForRun", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
  });
  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });

  it("rebuilds snapshot prompts for zai glm models", () => {
    const resolvedSkills = [
      {
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
      },
    ];
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "SNAPSHOT",
        skills: [],
        resolvedSkills,
      },
      workspaceDir: "/tmp/openclaw",
      provider: "zai",
      modelId: "glm-5",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).not.toBe("SNAPSHOT");
  });
});
