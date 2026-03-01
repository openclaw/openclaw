import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt, syncSkillsToWorkspace } from "./skills.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

let fixtureRoot = "";
let fixtureCount = 0;

async function createCaseDir(prefix: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-sync-suite-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("buildWorkspaceSkillsPrompt", () => {
  it("syncs merged skills into a target workspace", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const extraDir = path.join(sourceWorkspace, ".extra");
    const bundledDir = path.join(sourceWorkspace, ".bundled");
    const managedDir = path.join(sourceWorkspace, ".managed");

    await writeSkill({
      dir: path.join(extraDir, "demo-skill"),
      name: "demo-skill",
      description: "Extra version",
    });
    await writeSkill({
      dir: path.join(bundledDir, "demo-skill"),
      name: "demo-skill",
      description: "Bundled version",
    });
    await writeSkill({
      dir: path.join(managedDir, "demo-skill"),
      name: "demo-skill",
      description: "Managed version",
    });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "demo-skill"),
      name: "demo-skill",
      description: "Workspace version",
    });

    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      config: { skills: { load: { extraDirs: [extraDir] } } },
      bundledSkillsDir: bundledDir,
      managedSkillsDir: managedDir,
    });

    const prompt = buildWorkspaceSkillsPrompt(targetWorkspace, {
      bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
      managedSkillsDir: path.join(targetWorkspace, ".managed"),
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
    expect(prompt).not.toContain("Extra version");
    expect(prompt).toContain(path.join(targetWorkspace, "skills", "demo-skill", "SKILL.md"));
  });
  it("keeps synced skills confined under target workspace when frontmatter name uses traversal", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const escapeId = fixtureCount;
    const traversalName = `../../../skill-sync-escape-${escapeId}`;
    const escapedDest = path.resolve(targetWorkspace, "skills", traversalName);

    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "safe-traversal-skill"),
      name: traversalName,
      description: "Traversal skill",
    });

    expect(path.relative(path.join(targetWorkspace, "skills"), escapedDest).startsWith("..")).toBe(
      true,
    );
    expect(await pathExists(escapedDest)).toBe(false);

    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    expect(
      await pathExists(path.join(targetWorkspace, "skills", "safe-traversal-skill", "SKILL.md")),
    ).toBe(true);
    expect(await pathExists(escapedDest)).toBe(false);
  });
  it("keeps synced skills confined under target workspace when frontmatter name is absolute", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const escapeId = fixtureCount;
    const absoluteDest = path.join(os.tmpdir(), `skill-sync-abs-escape-${escapeId}`);

    await fs.rm(absoluteDest, { recursive: true, force: true });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "safe-absolute-skill"),
      name: absoluteDest,
      description: "Absolute skill",
    });

    expect(await pathExists(absoluteDest)).toBe(false);

    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    expect(
      await pathExists(path.join(targetWorkspace, "skills", "safe-absolute-skill", "SKILL.md")),
    ).toBe(true);
    expect(await pathExists(absoluteDest)).toBe(false);
  });
  it("filters skills based on env/config gates", async () => {
    const workspaceDir = await createCaseDir("workspace");
    const skillDir = path.join(workspaceDir, "skills", "nano-banana-pro");
    await writeSkill({
      dir: skillDir,
      name: "nano-banana-pro",
      description: "Generates images",
      metadata:
        '{"openclaw":{"requires":{"env":["GEMINI_API_KEY"]},"primaryEnv":"GEMINI_API_KEY"}}',
      body: "# Nano Banana\n",
    });

    withEnv({ GEMINI_API_KEY: undefined }, () => {
      const missingPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { entries: { "nano-banana-pro": { apiKey: "" } } } },
      });
      expect(missingPrompt).not.toContain("nano-banana-pro");

      const enabledPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: {
          skills: { entries: { "nano-banana-pro": { apiKey: "test-key" } } },
        },
      });
      expect(enabledPrompt).toContain("nano-banana-pro");
    });
  });
  it("applies skill filters, including empty lists", async () => {
    const workspaceDir = await createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "alpha"),
      name: "alpha",
      description: "Alpha skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "beta"),
      name: "beta",
      description: "Beta skill",
    });

    const filteredPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: ["alpha"],
    });
    expect(filteredPrompt).toContain("alpha");
    expect(filteredPrompt).not.toContain("beta");

    const emptyPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: [],
    });
    expect(emptyPrompt).toBe("");
  });
});
