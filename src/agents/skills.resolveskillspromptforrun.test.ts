import { describe, expect, it } from "vitest";
import { resolveSkillsPromptForRun } from "./skills.js";
import type { Skill } from "./skills/types.js";
import type { SkillEntry } from "./skills/types.js";
import { rewriteSkillPathsForSandbox } from "./skills/workspace.js";

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

  it("rewrites skill paths for sandbox when sandboxSkillsDir is provided", () => {
    const entry: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/home/user/.npm-global/lib/node_modules/openclaw/skills/demo-skill/SKILL.md",
        baseDir: "/home/user/.npm-global/lib/node_modules/openclaw/skills/demo-skill",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
      sandboxSkillsDir: "/workspace/skills",
    });
    expect(prompt).toContain("/workspace/skills/demo-skill/SKILL.md");
    expect(prompt).not.toContain(".npm-global");
  });
});

describe("rewriteSkillPathsForSandbox", () => {
  it("remaps filePath and baseDir to sandbox skills directory", () => {
    const skills: Skill[] = [
      {
        name: "github",
        description: "GitHub integration",
        filePath: "/home/user/.npm-global/lib/node_modules/openclaw/skills/github/SKILL.md",
        baseDir: "/home/user/.npm-global/lib/node_modules/openclaw/skills/github",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      {
        name: "web-search",
        description: "Web search",
        filePath: "/app/managed-skills/web-search/SKILL.md",
        baseDir: "/app/managed-skills/web-search",
        source: "managed",
        disableModelInvocation: false,
      },
    ];

    const result = rewriteSkillPathsForSandbox(skills, "/workspace/skills");

    expect(result[0].filePath).toBe("/workspace/skills/github/SKILL.md");
    expect(result[0].baseDir).toBe("/workspace/skills/github");
    expect(result[1].filePath).toBe("/workspace/skills/web-search/SKILL.md");
    expect(result[1].baseDir).toBe("/workspace/skills/web-search");
  });

  it("preserves all other skill properties", () => {
    const skill: Skill = {
      name: "test",
      description: "Test skill",
      filePath: "/host/skills/test/SKILL.md",
      baseDir: "/host/skills/test",
      source: "openclaw-bundled",
      disableModelInvocation: true,
    };

    const [result] = rewriteSkillPathsForSandbox([skill], "/sandbox/skills");

    expect(result.name).toBe("test");
    expect(result.description).toBe("Test skill");
    expect(result.source).toBe("openclaw-bundled");
    expect(result.disableModelInvocation).toBe(true);
  });
});
