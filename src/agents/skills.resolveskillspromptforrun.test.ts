import { describe, expect, it } from "vitest";
import { resolveSkillsPromptForRun } from "./skills.js";
import type { SkillEntry, SkillEligibilityContext } from "./skills/types.js";

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
  it("can prefer live entries over a snapshot prompt", () => {
    const entry: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/workspace/skills/demo-skill/SKILL.md",
        baseDir: "/workspace/skills/demo-skill",
        source: "workspace",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "HOST-SNAPSHOT", skills: [] },
      entries: [entry],
      workspaceDir: "/workspace",
      preferEntries: true,
    });
    expect(prompt).not.toContain("HOST-SNAPSHOT");
    expect(prompt).toContain("/workspace/skills/demo-skill/SKILL.md");
  });
  it("preserves remote eligibility note when preferring entries", () => {
    const entry: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/workspace/skills/demo-skill/SKILL.md",
        baseDir: "/workspace/skills/demo-skill",
        source: "workspace",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const eligibility: SkillEligibilityContext = {
      remote: {
        platforms: ["darwin"],
        hasBin: () => true,
        hasAnyBin: () => true,
        note: "Remote macOS node available. Run macOS-only skills via nodes.run.",
      },
    };
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "HOST-SNAPSHOT", skills: [] },
      entries: [entry],
      workspaceDir: "/workspace",
      preferEntries: true,
      eligibility,
    });
    expect(prompt).toContain("Remote macOS node available");
    expect(prompt).toContain("/workspace/skills/demo-skill/SKILL.md");
  });
});
