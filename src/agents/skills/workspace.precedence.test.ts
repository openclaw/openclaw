/**
 * Regression tests for skill precedence order:
 *   extra < bundled < managed(global) < agents-skills-personal < agents-skills-project < workspace
 *
 * The workspace (local project) skills must always win over the global (~/.openclaw/skills)
 * managed skills when both define a skill with the same name.
 * See: https://github.com/openclaw/openclaw/issues/55374
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSkill } from "../skills.e2e-test-helpers.js";
import { loadWorkspaceSkillEntries } from "./workspace.js";

describe("skill loading precedence", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let managedSkillsDir: string;
  let bundledSkillsDir: string;
  let personalAgentsSkillsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-precedence-"));
    workspaceDir = path.join(tmpDir, "workspace");
    managedSkillsDir = path.join(tmpDir, "managed");
    bundledSkillsDir = path.join(tmpDir, "bundled");
    // Use a temp dir instead of the real ~/.agents/skills so tests are hermetic
    // even on developer machines that have personal agent skills installed.
    personalAgentsSkillsDir = path.join(tmpDir, "personal-agents");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(managedSkillsDir, { recursive: true });
    await fs.mkdir(bundledSkillsDir, { recursive: true });
    await fs.mkdir(personalAgentsSkillsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("workspace skill takes precedence over managed (global) skill with the same name", async () => {
    const skillName = "my-skill";

    await writeSkill({
      dir: path.join(managedSkillsDir, skillName),
      name: skillName,
      description: "global version",
    });

    await writeSkill({
      dir: path.join(workspaceDir, "skills", skillName),
      name: skillName,
      description: "workspace version",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir,
      bundledSkillsDir,
      personalAgentsSkillsDir,
    });

    const match = entries.find((e) => e.skill.name === skillName);
    expect(match).toBeDefined();
    expect(match?.skill.source).toBe("openclaw-workspace");
    expect(match?.frontmatter.description).toBe("workspace version");
  });

  it("managed skill is used when no workspace skill with the same name exists", async () => {
    const skillName = "global-only-skill";

    await writeSkill({
      dir: path.join(managedSkillsDir, skillName),
      name: skillName,
      description: "only in global",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir,
      bundledSkillsDir,
      personalAgentsSkillsDir,
    });

    const match = entries.find((e) => e.skill.name === skillName);
    expect(match).toBeDefined();
    expect(match?.skill.source).toBe("openclaw-managed");
  });

  it("workspace skill takes precedence over bundled skill with the same name", async () => {
    const skillName = "bundled-vs-workspace";

    await writeSkill({
      dir: path.join(bundledSkillsDir, skillName),
      name: skillName,
      description: "bundled version",
    });

    await writeSkill({
      dir: path.join(workspaceDir, "skills", skillName),
      name: skillName,
      description: "workspace version",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir,
      bundledSkillsDir,
      personalAgentsSkillsDir,
    });

    const match = entries.find((e) => e.skill.name === skillName);
    expect(match).toBeDefined();
    expect(match?.skill.source).toBe("openclaw-workspace");
  });

  it("managed skill takes precedence over bundled skill with the same name", async () => {
    const skillName = "managed-vs-bundled";

    await writeSkill({
      dir: path.join(bundledSkillsDir, skillName),
      name: skillName,
      description: "bundled version",
    });

    await writeSkill({
      dir: path.join(managedSkillsDir, skillName),
      name: skillName,
      description: "managed version",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir,
      bundledSkillsDir,
      personalAgentsSkillsDir,
    });

    const match = entries.find((e) => e.skill.name === skillName);
    expect(match).toBeDefined();
    expect(match?.skill.source).toBe("openclaw-managed");
  });
});
