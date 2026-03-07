import { describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import type { SkillEligibilityContext, SkillEntry } from "./skills/types.js";
import { resolveSkillsPromptForRun } from "./skills/workspace.js";

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
      skill: createFixtureSkill({
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
      }),
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });

  it("keeps legacy entries with disableModelInvocation hidden when exposure metadata is absent", () => {
    const hidden: SkillEntry = {
      skill: createFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
        disableModelInvocation: true,
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [hidden],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("inherits agents.defaults.skills when rebuilding prompt for an agent", () => {
    const visible: SkillEntry = {
      skill: createFixtureSkill({
        name: "github",
        description: "GitHub",
        filePath: "/app/skills/github/SKILL.md",
        baseDir: "/app/skills/github",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const hidden: SkillEntry = {
      skill: createFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [visible, hidden],
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).toContain("/app/skills/github/SKILL.md");
    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("uses agents.list[].skills as a full replacement for defaults", () => {
    const inheritedEntry: SkillEntry = {
      skill: createFixtureSkill({
        name: "weather",
        description: "Weather",
        filePath: "/app/skills/weather/SKILL.md",
        baseDir: "/app/skills/weather",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const explicitEntry: SkillEntry = {
      skill: createFixtureSkill({
        name: "docs-search",
        description: "Docs",
        filePath: "/app/skills/docs-search/SKILL.md",
        baseDir: "/app/skills/docs-search",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [inheritedEntry, explicitEntry],
      config: {
        agents: {
          defaults: {
            skills: ["weather"],
          },
          list: [{ id: "writer", skills: ["docs-search"] }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).not.toContain("/app/skills/weather/SKILL.md");
    expect(prompt).toContain("/app/skills/docs-search/SKILL.md");
  });

  it("can prefer live entries over a snapshot prompt", () => {
    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "demo-skill",
        description: "Demo",
        filePath: "/workspace/skills/demo-skill/SKILL.md",
        baseDir: "/workspace/skills/demo-skill",
        source: "workspace",
        disableModelInvocation: false,
      }),
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

  it("does not fall back to snapshot prompt when preferred live entries are empty", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "HOST-SNAPSHOT", skills: [] },
      entries: [],
      workspaceDir: "/workspace",
      preferEntries: true,
    });

    expect(prompt).toBe("");
  });

  it("preserves snapshot skill filter when rebuilding a preferred live prompt", () => {
    const visible: SkillEntry = {
      skill: createFixtureSkill({
        name: "github",
        description: "GitHub",
        filePath: "/workspace/skills/github/SKILL.md",
        baseDir: "/workspace/skills/github",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const hidden: SkillEntry = {
      skill: createFixtureSkill({
        name: "weather",
        description: "Weather",
        filePath: "/workspace/skills/weather/SKILL.md",
        baseDir: "/workspace/skills/weather",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "HOST-SNAPSHOT",
        skills: [],
        skillFilter: ["github"],
      },
      entries: [visible, hidden],
      workspaceDir: "/workspace",
      preferEntries: true,
    });

    expect(prompt).toContain("/workspace/skills/github/SKILL.md");
    expect(prompt).not.toContain("/workspace/skills/weather/SKILL.md");
  });

  it("preserves remote eligibility note when preferring entries", () => {
    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "demo-skill",
        description: "Demo",
        filePath: "/workspace/skills/demo-skill/SKILL.md",
        baseDir: "/workspace/skills/demo-skill",
        source: "workspace",
        disableModelInvocation: false,
      }),
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

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation?: boolean;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}
