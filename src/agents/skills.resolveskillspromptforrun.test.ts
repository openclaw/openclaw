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
  it("applies skillFilter when snapshot is absent", () => {
    const alpha: SkillEntry = {
      skill: {
        name: "alpha",
        description: "Alpha skill",
        filePath: "/app/skills/alpha/SKILL.md",
        baseDir: "/app/skills/alpha",
        source: "openclaw-bundled",
      },
      frontmatter: {},
    };
    const beta: SkillEntry = {
      skill: {
        name: "beta",
        description: "Beta skill",
        filePath: "/app/skills/beta/SKILL.md",
        baseDir: "/app/skills/beta",
        source: "openclaw-bundled",
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [alpha, beta],
      workspaceDir: "/tmp/openclaw",
      skillFilter: ["alpha"],
    });
    expect(prompt).toContain("alpha");
    expect(prompt).not.toContain("beta");
  });
  it("returns empty when skillFilter is an empty array", () => {
    const entry: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
      skillFilter: [],
    });
    expect(prompt).toBe("");
  });
});
