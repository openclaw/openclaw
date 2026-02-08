import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkspaceSkillEntries } from "./skills.js";

async function writeSkill(params: {
  dir: string;
  name: string;
  description: string;
}) {
  const { dir, name, description } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

# ${name}
`,
    "utf-8",
  );
}

describe("loadWorkspaceSkillEntries - project-scoped skills", () => {
  it("loads skills from .claude/skills in cwd", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const claudeSkillsDir = path.join(projectDir, ".claude", "skills");

    await writeSkill({
      dir: path.join(claudeSkillsDir, "testing-best-practices"),
      name: "testing-best-practices",
      description: "Testing conventions for this project",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
      cwd: projectDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("testing-best-practices");
  });

  it("loads skills from .agents/skills in cwd", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const agentsSkillsDir = path.join(projectDir, ".agents", "skills");

    await writeSkill({
      dir: path.join(agentsSkillsDir, "cross-agent-skill"),
      name: "cross-agent-skill",
      description: "A cross-agent skill using the .agents convention",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
      cwd: projectDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("cross-agent-skill");
  });

  it("loads skills from both .claude/skills and .agents/skills in cwd", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const claudeSkillsDir = path.join(projectDir, ".claude", "skills");
    const agentsSkillsDir = path.join(projectDir, ".agents", "skills");

    await writeSkill({
      dir: path.join(claudeSkillsDir, "claude-skill"),
      name: "claude-skill",
      description: "Claude Code specific skill",
    });
    await writeSkill({
      dir: path.join(agentsSkillsDir, "agents-skill"),
      name: "agents-skill",
      description: "Cross-agent skill",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
      cwd: projectDir,
    });

    const names = entries.map((entry) => entry.skill.name);
    expect(names).toContain("claude-skill");
    expect(names).toContain("agents-skill");
  });

  it(".claude/skills takes precedence over .agents/skills for same skill name", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const claudeSkillsDir = path.join(projectDir, ".claude", "skills");
    const agentsSkillsDir = path.join(projectDir, ".agents", "skills");

    await writeSkill({
      dir: path.join(claudeSkillsDir, "shared-skill"),
      name: "shared-skill",
      description: "Claude version of shared skill",
    });
    await writeSkill({
      dir: path.join(agentsSkillsDir, "shared-skill"),
      name: "shared-skill",
      description: "Agents version of shared skill",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
      cwd: projectDir,
    });

    const sharedSkill = entries.find((entry) => entry.skill.name === "shared-skill");
    expect(sharedSkill).toBeDefined();
    expect(sharedSkill!.skill.description).toBe("Claude version of shared skill");
  });

  it("workspace/skills takes precedence over project-scoped skills in cwd", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const workspaceSkillsDir = path.join(workspaceDir, "skills");
    const claudeSkillsDir = path.join(projectDir, ".claude", "skills");

    await writeSkill({
      dir: path.join(workspaceSkillsDir, "my-skill"),
      name: "my-skill",
      description: "Workspace version",
    });
    await writeSkill({
      dir: path.join(claudeSkillsDir, "my-skill"),
      name: "my-skill",
      description: "Claude project version",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
      cwd: projectDir,
    });

    const mySkill = entries.find((entry) => entry.skill.name === "my-skill");
    expect(mySkill).toBeDefined();
    expect(mySkill!.skill.description).toBe("Workspace version");
  });

  it("does not error when cwd has no .claude/skills or .agents/skills", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
      cwd: projectDir,
    });

    const projectSources = entries.filter(
      (e) => e.skill.source === "project-claude" || e.skill.source === "project-agents",
    );
    expect(projectSources).toEqual([]);
  });

  it("falls back to workspaceDir when cwd is not provided", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const claudeSkillsDir = path.join(workspaceDir, ".claude", "skills");

    await writeSkill({
      dir: path.join(claudeSkillsDir, "workspace-claude-skill"),
      name: "workspace-claude-skill",
      description: "Skill in workspace .claude/skills",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
      // cwd not provided, should fall back to workspaceDir
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("workspace-claude-skill");
  });
});
