import { describe, expect, it } from "vitest";
import { pruneSkillsForPrompt } from "./dynamic-skill-pruning.js";

const makeSkill = (name: string, description: string) => ({
  name,
  description,
  filePath: `/skills/${name}/SKILL.md`,
  baseDir: `/skills/${name}`,
  source: "workspace" as const,
  disableModelInvocation: false,
});

describe("pruneSkillsForPrompt", () => {
  it("prunes weather, ops, and skill-authoring skills when prompt signals are absent", () => {
    const result = pruneSkillsForPrompt({
      taskProfile: "coding",
      promptText: "Explain how src/version.ts works without changing any files.",
      skills: [
        makeSkill("clawhub", "Workspace knowledge hub"),
        makeSkill("weather", "Weather forecast lookup"),
        makeSkill("healthcheck", "Inspect runtime health"),
        makeSkill("node-connect", "Connect to nodes and runtimes"),
        makeSkill("skill-creator", "Create new skills"),
      ],
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["clawhub"]);
    expect(result.report.prunedCount).toBe(4);
  });

  it("keeps ops skills for ops-shaped prompts", () => {
    const result = pruneSkillsForPrompt({
      taskProfile: "ops",
      promptText: "Check gateway health and inspect runtime logs.",
      skills: [
        makeSkill("clawhub", "Workspace knowledge hub"),
        makeSkill("healthcheck", "Inspect runtime health"),
        makeSkill("node-connect", "Connect to nodes and runtimes"),
      ],
    });

    expect(result.skills.map((skill) => skill.name)).toEqual([
      "clawhub",
      "healthcheck",
      "node-connect",
    ]);
    expect(result.report.prunedCount).toBe(0);
  });
});
