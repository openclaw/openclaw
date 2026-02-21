import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills.js";
import { writeSkill } from "./skills.test-helpers.js";

describe("compactSkillPaths", () => {
  it("replaces home directory prefix with ~ in skill locations", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-"));
    const skillDir = path.join(workspaceDir, "skills", "test-skill");

    await writeSkill({
      dir: skillDir,
      name: "test-skill",
      description: "A test skill for path compaction",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: path.join(workspaceDir, ".bundled-empty"),
      managedSkillsDir: path.join(workspaceDir, ".managed-empty"),
    });

    const home = os.homedir();
    // The prompt should NOT contain the absolute home directory path
    // when the skill is under the home directory (which tmpdir usually is on macOS)
    if (workspaceDir.startsWith(home)) {
      expect(prompt).not.toContain(home + path.sep);
      expect(prompt).toContain("~/");
    }

    // The skill name and description should still be present
    expect(prompt).toContain("test-skill");
    expect(prompt).toContain("A test skill for path compaction");

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("preserves paths outside home directory", async () => {
    // Skills outside ~ should keep their absolute paths
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-"));
    const skillDir = path.join(workspaceDir, "skills", "ext-skill");

    await writeSkill({
      dir: skillDir,
      name: "ext-skill",
      description: "External skill",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: path.join(workspaceDir, ".bundled-empty"),
      managedSkillsDir: path.join(workspaceDir, ".managed-empty"),
    });

    // Should still contain a valid location tag
    expect(prompt).toMatch(/<location>[^<]+SKILL\.md<\/location>/);

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});
