import { describe, expect, it } from "vitest";
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

  it("respects skillFilter from snapshot when building from entries", () => {
    const entry1: SkillEntry = {
      skill: {
        name: "allowed-skill",
        description: "Allowed",
        filePath: "/app/skills/allowed-skill/SKILL.md",
        baseDir: "/app/skills/allowed-skill",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const entry2: SkillEntry = {
      skill: {
        name: "filtered-skill",
        description: "Filtered",
        filePath: "/app/skills/filtered-skill/SKILL.md",
        baseDir: "/app/skills/filtered-skill",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "",
        skills: [],
        skillFilter: ["allowed-skill"],
      },
      entries: [entry1, entry2],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("allowed-skill");
    expect(prompt).not.toContain("filtered-skill");
  });

  it("applies empty skillFilter correctly (no skills in prompt)", () => {
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
      skillsSnapshot: {
        prompt: "",
        skills: [],
        skillFilter: [],
      },
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("");
  });
});
