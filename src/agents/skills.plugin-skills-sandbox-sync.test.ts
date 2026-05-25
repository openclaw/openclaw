import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { syncSkillsToWorkspace } from "./skills/workspace.js";

// Mock resolvePluginSkillDirs to return our test plugin skill directories
const mockResolvePluginSkillDirs = vi.hoisted(() => vi.fn(() => [] as string[]));

vi.mock("./skills/plugin-skills.js", () => ({
  resolvePluginSkillDirs: mockResolvePluginSkillDirs,
}));

let fixtureRoot = "";
let fixtureCount = 0;

async function createCaseDir(prefix: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fsPromises.mkdir(dir, { recursive: true });
  return dir;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  fixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-skills-sync-"));
});

afterAll(async () => {
  await fsPromises.rm(fixtureRoot, { recursive: true, force: true });
});

describe("syncSkillsToWorkspace for plugin skills", () => {
  it("syncs plugin skills from symlinked directories to sandbox workspace", async () => {
    // Setup: create a real plugin skill directory and a symlink to it
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");

    // Create the real plugin skill directory (outside the plugin-skills dir)
    const realPluginSkillDir = await createCaseDir("real-plugin-skill");
    await writeSkill({
      dir: realPluginSkillDir,
      name: "wiki-maintainer",
      description: "Wiki maintenance skill for sandboxed agents",
    });

    // Create the plugin-skills directory with a symlink
    const pluginSkillsDir = path.join(sourceWorkspace, ".openclaw", "plugin-skills");
    await fsPromises.mkdir(pluginSkillsDir, { recursive: true });
    const symlinkPath = path.join(pluginSkillsDir, "wiki-maintainer");

    // Create symlink from plugin-skills to real skill directory
    fs.symlinkSync(
      realPluginSkillDir,
      symlinkPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    // Configure mock to return the real plugin skill directory
    mockResolvePluginSkillDirs.mockReturnValueOnce([realPluginSkillDir]);

    // Run sync
    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir: pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    // Verify: plugin skill should be synced to target workspace as real directory
    const syncedSkillDir = path.join(targetWorkspace, "skills", "wiki-maintainer");
    expect(await pathExists(path.join(syncedSkillDir, "SKILL.md"))).toBe(true);

    // The synced directory should NOT be a symlink (sandbox needs real files)
    const syncedStat = await fsPromises.lstat(syncedSkillDir);
    expect(syncedStat.isSymbolicLink()).toBe(false);

    // The SKILL.md content should match the original
    const originalContent = await fsPromises.readFile(
      path.join(realPluginSkillDir, "SKILL.md"),
      "utf-8",
    );
    const syncedContent = await fsPromises.readFile(
      path.join(syncedSkillDir, "SKILL.md"),
      "utf-8",
    );
    expect(syncedContent).toBe(originalContent);
  });

  it("syncs multiple plugin skills directories to sandbox workspace", async () => {
    const sourceWorkspace = await createCaseDir("source-multi");
    const targetWorkspace = await createCaseDir("target-multi");

    // Create multiple real plugin skill directories
    const realSkillA = await createCaseDir("skill-a");
    await writeSkill({
      dir: realSkillA,
      name: "browser-automation",
      description: "Browser automation skill",
    });

    const realSkillB = await createCaseDir("skill-b");
    await writeSkill({
      dir: realSkillB,
      name: "obsidian-vault",
      description: "Obsidian vault maintenance skill",
    });

    // Create plugin-skills directory with symlinks
    const pluginSkillsDir = path.join(sourceWorkspace, ".openclaw", "plugin-skills");
    await fsPromises.mkdir(pluginSkillsDir, { recursive: true });

    fs.symlinkSync(
      realSkillA,
      path.join(pluginSkillsDir, "browser-automation"),
      process.platform === "win32" ? "junction" : "dir",
    );
    fs.symlinkSync(
      realSkillB,
      path.join(pluginSkillsDir, "obsidian-vault"),
      process.platform === "win32" ? "junction" : "dir",
    );

    mockResolvePluginSkillDirs.mockReturnValueOnce([realSkillA, realSkillB]);

    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir: pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    // Both skills should be synced
    expect(await pathExists(path.join(targetWorkspace, "skills", "browser-automation", "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(targetWorkspace, "skills", "obsidian-vault", "SKILL.md"))).toBe(true);
  });

  it("does not sync plugin skills that escape allowed root", async () => {
    const sourceWorkspace = await createCaseDir("source-escape");
    const targetWorkspace = await createCaseDir("target-escape");

    // Create a skill outside any allowed root
    const outsideRoot = await createCaseDir("outside-root");
    const escapedSkillDir = path.join(outsideRoot, "escaped-skill");
    await writeSkill({
      dir: escapedSkillDir,
      name: "escaped-skill",
      description: "Should not be synced",
    });

    // Create plugin-skills with symlink to escaped skill
    const pluginSkillsDir = path.join(sourceWorkspace, ".openclaw", "plugin-skills");
    await fsPromises.mkdir(pluginSkillsDir, { recursive: true });
    fs.symlinkSync(
      escapedSkillDir,
      path.join(pluginSkillsDir, "escaped-skill"),
      process.platform === "win32" ? "junction" : "dir",
    );

    // Mock returns an allowed root that doesn't include the escaped skill
    const allowedRoot = await createCaseDir("allowed-root");
    mockResolvePluginSkillDirs.mockReturnValueOnce([allowedRoot]);

    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir: pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    // Escaped skill should NOT be synced
    expect(await pathExists(path.join(targetWorkspace, "skills", "escaped-skill", "SKILL.md"))).toBe(false);
  });
});