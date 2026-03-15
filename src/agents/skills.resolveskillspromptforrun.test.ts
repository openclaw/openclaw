import type { Skill } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveSkillsPromptForRun } from "./skills.js";
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

  it("rewrites snapshot skill paths for sandbox via string replacement", () => {
    const resolvedSkills: Skill[] = [
      {
        name: "github",
        description: "GitHub integration",
        filePath: "/opt/openclaw/skills/github/SKILL.md",
        baseDir: "/opt/openclaw/skills/github",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
    ];
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt:
          "<available_skills>\n  <skill>\n    <name>github</name>\n    <description>GitHub integration</description>\n    <location>/opt/openclaw/skills/github/SKILL.md</location>\n  </skill>\n</available_skills>",
        skills: [{ name: "github" }],
        resolvedSkills,
      },
      workspaceDir: "/tmp/openclaw",
      sandboxSkillsDir: "/workspace/skills",
    });
    expect(prompt).toContain("/workspace/skills/github/SKILL.md");
    expect(prompt).not.toContain("/opt/openclaw");
    // Verify snapshot structure is preserved (not rebuilt)
    expect(prompt).toContain("<name>github</name>");
  });

  it("preserves snapshot truncation when rewriting sandbox paths", () => {
    // Snapshot prompt only contains skill-a (skill-b was truncated)
    const resolvedSkills: Skill[] = [
      {
        name: "skill-a",
        description: "A",
        filePath: "/opt/skills/skill-a/SKILL.md",
        baseDir: "/opt/skills/skill-a",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      {
        name: "skill-b",
        description: "B",
        filePath: "/opt/skills/skill-b/SKILL.md",
        baseDir: "/opt/skills/skill-b",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
    ];
    const truncatedPrompt =
      "⚠️ Skills truncated\n<available_skills>\n  <skill>\n    <name>skill-a</name>\n    <location>/opt/skills/skill-a/SKILL.md</location>\n  </skill>\n</available_skills>";
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: truncatedPrompt,
        skills: [{ name: "skill-a" }],
        resolvedSkills,
      },
      workspaceDir: "/tmp/openclaw",
      sandboxSkillsDir: "/workspace/skills",
    });
    // skill-a path rewritten
    expect(prompt).toContain("/workspace/skills/skill-a/SKILL.md");
    // skill-b NOT added back (truncation preserved)
    expect(prompt).not.toContain("skill-b");
    // Truncation warning preserved
    expect(prompt).toContain("⚠️ Skills truncated");
  });

  it("falls back to snapshot prompt when no resolvedSkills for sandbox", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "SNAPSHOT_HOST_PATHS",
        skills: [{ name: "github" }],
      },
      workspaceDir: "/tmp/openclaw",
      sandboxSkillsDir: "/workspace/skills",
    });
    expect(prompt).toBe("SNAPSHOT_HOST_PATHS");
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
