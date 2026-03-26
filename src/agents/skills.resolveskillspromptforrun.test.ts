import { describe, expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
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
  it("filters snapshot-resolved skills when a task profile is provided", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "UNFILTERED",
        skills: [{ name: "weather" }, { name: "clawhub" }, { name: "healthcheck", always: true }],
        resolvedSkills: [
          {
            name: "weather",
            description: "Weather forecast lookup",
            filePath: "/app/skills/weather/SKILL.md",
            baseDir: "/app/skills/weather",
            source: "workspace",
            disableModelInvocation: false,
          },
          {
            name: "clawhub",
            description: "Workspace knowledge hub",
            filePath: "/app/skills/clawhub/SKILL.md",
            baseDir: "/app/skills/clawhub",
            source: "workspace",
            disableModelInvocation: false,
          },
          {
            name: "healthcheck",
            description: "Inspect runtime health",
            filePath: "/app/skills/healthcheck/SKILL.md",
            baseDir: "/app/skills/healthcheck",
            source: "workspace",
            disableModelInvocation: false,
          },
        ],
      },
      taskProfile: "assistant",
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("weather");
    expect(prompt).toContain("clawhub");
    expect(prompt).toContain("healthcheck");
    expect(prompt).not.toBe("UNFILTERED");
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
  it("filters entry-built prompts for research task profiles", () => {
    const entries: SkillEntry[] = [
      {
        skill: {
          name: "healthcheck",
          description: "Inspect runtime health",
          filePath: "/app/skills/healthcheck/SKILL.md",
          baseDir: "/app/skills/healthcheck",
          source: "workspace",
          disableModelInvocation: false,
        },
        frontmatter: {},
      },
      {
        skill: {
          name: "clawhub",
          description: "Workspace knowledge hub",
          filePath: "/app/skills/clawhub/SKILL.md",
          baseDir: "/app/skills/clawhub",
          source: "workspace",
          disableModelInvocation: false,
        },
        frontmatter: {},
      },
    ];
    const prompt = resolveSkillsPromptForRun({
      entries,
      taskProfile: "research",
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("clawhub");
    expect(prompt).not.toContain("healthcheck");
  });
  it("dynamically prunes prompt-irrelevant skills after task-profile filtering", () => {
    const skillPruningReportRef: { current?: SessionSystemPromptReport["skillPruning"] } = {};
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: {
        prompt: "UNFILTERED",
        skills: [{ name: "clawhub" }, { name: "healthcheck" }, { name: "skill-creator" }],
        resolvedSkills: [
          {
            name: "clawhub",
            description: "Workspace knowledge hub",
            filePath: "/app/skills/clawhub/SKILL.md",
            baseDir: "/app/skills/clawhub",
            source: "workspace",
            disableModelInvocation: false,
          },
          {
            name: "healthcheck",
            description: "Inspect runtime health",
            filePath: "/app/skills/healthcheck/SKILL.md",
            baseDir: "/app/skills/healthcheck",
            source: "workspace",
            disableModelInvocation: false,
          },
          {
            name: "skill-creator",
            description: "Create new skills",
            filePath: "/app/skills/skill-creator/SKILL.md",
            baseDir: "/app/skills/skill-creator",
            source: "workspace",
            disableModelInvocation: false,
          },
        ],
      },
      taskProfile: "coding",
      promptText: "Explain how src/version.ts works without changing any files.",
      dynamicSkillPruningReportRef: skillPruningReportRef,
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("clawhub");
    expect(prompt).not.toContain("healthcheck");
    expect(prompt).not.toContain("skill-creator");
    expect(skillPruningReportRef.current?.prunedCount).toBe(2);
  });
});
