import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills.js";

async function writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  body?: string;
}) {
  const { dir, name, description, body } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

${body ?? `# ${name}\n`}
`,
    "utf-8",
  );
}

describe("buildWorkspaceSkillsPrompt — .agents/skills/ directories", () => {
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads project .agents/skills/ above managed and below workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");

    await writeSkill({
      dir: path.join(managedDir, "shared-skill"),
      name: "shared-skill",
      description: "Managed version",
    });
    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
      description: "Project agents version",
    });

    // project .agents/skills/ wins over managed
    const prompt1 = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });
    expect(prompt1).toContain("Project agents version");
    expect(prompt1).not.toContain("Managed version");

    // workspace wins over project .agents/skills/
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "shared-skill"),
      name: "shared-skill",
      description: "Workspace version",
    });

    const prompt2 = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });
    expect(prompt2).toContain("Workspace version");
    expect(prompt2).not.toContain("Project agents version");
  });

  it("loads personal ~/.agents/skills/ above managed and below project .agents/skills/", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");

    await writeSkill({
      dir: path.join(managedDir, "shared-skill"),
      name: "shared-skill",
      description: "Managed version",
    });
    await writeSkill({
      dir: path.join(fakeHome, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
      description: "Personal agents version",
    });

    // personal wins over managed
    const prompt1 = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });
    expect(prompt1).toContain("Personal agents version");
    expect(prompt1).not.toContain("Managed version");

    // project .agents/skills/ wins over personal
    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
      description: "Project agents version",
    });

    const prompt2 = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });
    expect(prompt2).toContain("Project agents version");
    expect(prompt2).not.toContain("Personal agents version");
  });

  it("loads unique skills from all .agents/skills/ sources alongside others", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");

    await writeSkill({
      dir: path.join(managedDir, "managed-only"),
      name: "managed-only",
      description: "Managed only skill",
    });
    await writeSkill({
      dir: path.join(fakeHome, ".agents", "skills", "personal-only"),
      name: "personal-only",
      description: "Personal only skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "project-only"),
      name: "project-only",
      description: "Project only skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "workspace-only"),
      name: "workspace-only",
      description: "Workspace only skill",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });
    expect(prompt).toContain("managed-only");
    expect(prompt).toContain("personal-only");
    expect(prompt).toContain("project-only");
    expect(prompt).toContain("workspace-only");
  });
});
