import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { loadWorkspaceSkillEntries } from "./workspace.js";

const tempDirs = createTrackedTempDirs();

describe("loadWorkspaceSkillEntries", () => {
  let workspaceDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    workspaceDir = await tempDirs.make("openclaw-workspace-");
    skillsDir = path.join(workspaceDir, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await tempDirs.cleanup();
  });

  it("warns when SKILL.md exists but no skills are loaded due to parse failure", async () => {
    const skillName = "parse-failure-test";
    const skillDir = path.join(skillsDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });

    // Create a malformed SKILL.md that will fail to parse
    const malformedSkillMd = `
# Invalid SKILL.md

This is missing the required frontmatter sections.

No ## Description or ## Usage sections here.
`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), malformedSkillMd, "utf-8");

    // Mock logger to capture warnings
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const entries = loadWorkspaceSkillEntries(workspaceDir);

      // The skill should not be in the loaded entries
      const hasParseFailureSkill = entries.some((e) => e.skill.name === skillName);
      expect(hasParseFailureSkill).toBe(false);

      // The warning should have been logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Failed to parse SKILL.md - file exists but no skills loaded",
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when SKILL.md does not exist", async () => {
    const skillName = "no-skill-md";
    const skillDir = path.join(skillsDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });

    // Create some other files but no SKILL.md
    await fs.writeFile(path.join(skillDir, "README.md"), "Just a readme", "utf-8");

    // Mock logger to ensure no warnings are logged
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const entries = loadWorkspaceSkillEntries(workspaceDir);

      // The skill should not be in the loaded entries
      const hasNoSkillMdSkill = entries.some((e) => e.skill.name === skillName);
      expect(hasNoSkillMdSkill).toBe(false);

      // No parse failure warning should have been logged for this directory
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Failed to parse SKILL.md - file exists but no skills loaded",
          skill: skillName,
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("tracks parse failures in summary", async () => {
    const skillName = "parse-failure-tracked";
    const skillDir = path.join(skillsDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });

    // Create a malformed SKILL.md
    const malformedSkillMd = `
# Malformed Skill
`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), malformedSkillMd, "utf-8");

    // Mock logger to capture info logs
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      loadWorkspaceSkillEntries(workspaceDir);

      // Check that the summary log includes parseFailures
      const summaryCalls = infoSpy.mock.calls.filter(
        (call) => call[0]?.message === "Skills loading completed",
      );

      expect(summaryCalls.length).toBeGreaterThan(0);
      expect(summaryCalls[0][0]).toMatchObject({
        parseFailures: expect.any(Number),
      });

      // parseFailures should be at least 1
      expect(summaryCalls[0][0].parseFailures).toBeGreaterThanOrEqual(1);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
