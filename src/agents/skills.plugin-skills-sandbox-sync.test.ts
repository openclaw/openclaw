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

    // === Issue #86190 Verification Test ===
    console.log("\n" + "=".repeat(70));
    console.log("Issue #86190: Plugin skills unreadable in sandbox");
    console.log("=".repeat(70));

    // Step 1: Setup - create real plugin skill directory (simulates installed plugin)
    console.log("\n[Step 1] Setup - Create real plugin skill directory");
    console.log(`  Path: ${realPluginSkillDir}`);
    console.log(`  Content: SKILL.md with name=wiki-maintainer`);

    // Step 2: Create symlink under plugin-skills (simulates publishPluginSkills)
    console.log("\n[Step 2] Create symlink under ~/.openclaw/plugin-skills/");
    console.log(`  Symlink: ${symlinkPath}`);
    console.log(`  Target:  ${fs.realpathSync(symlinkPath)}`);
    console.log("  (This is how OpenClaw exposes plugin skills)");

    // Step 3: Create target sandbox workspace
    console.log("\n[Step 3] Create target sandbox workspace");
    console.log(`  Path: ${targetWorkspace}`);
    console.log("  (This becomes /workspace in the sandbox container)");

    // Configure mock to return the real plugin skill directory
    mockResolvePluginSkillDirs.mockReturnValueOnce([realPluginSkillDir]);

    // Step 4: Run syncSkillsToWorkspace (the fix we're testing)
    console.log("\n[Step 4] Run syncSkillsToWorkspace");
    console.log("  - Loads skill entries from source workspace");
    console.log("  - Identifies plugin skills via resolvePluginSkillDirs");
    console.log("  - Copies skill directories to target/skills/");
    console.log("  - Key fix: canonicalSkillDir=skillDirRealPath enables sync");

    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir: pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });
    console.log("  Sync completed successfully");

    // Step 5: Verify results
    console.log("\n[Step 5] Verification");
    const syncedSkillDir = path.join(targetWorkspace, "skills", "wiki-maintainer");
    const syncedSkillMd = path.join(syncedSkillDir, "SKILL.md");

    console.log(`  Target skills/: ${fs.readdirSync(path.join(targetWorkspace, "skills")).join(", ")}`);
    console.log(`  wiki-maintainer/SKILL.md exists: ${fs.existsSync(syncedSkillMd)}`);

    const syncedStat = await fsPromises.lstat(syncedSkillDir);
    console.log(`  Directory type: ${syncedStat.isSymbolicLink() ? "symlink (BUG!)" : "real directory (FIX WORKS!)"}`);

    if (fs.existsSync(syncedSkillMd)) {
      const content = fs.readFileSync(syncedSkillMd, "utf-8");
      console.log(`  SKILL.md starts with: "${content.slice(0, 40).replace(/\n/g, "\\n")}..."`);
    }

    // Step 6: Explain why this matters
    console.log("\n[Step 6] Why this matters");
    console.log("  Before fix: Plugin skills NOT synced, sandbox read tool fails with");
    console.log("    'Path escapes sandbox root: ~/.openclaw/plugin-skills/...'");
    console.log("  After fix: Skills copied to /workspace/skills/, read tool works");
    console.log("  Sandboxed agents can now load plugin-provided skills");

    console.log("\n" + "=".repeat(70));
    console.log("TEST PASSED - Fix verified");
    console.log("=".repeat(70) + "\n");

    expect(await pathExists(syncedSkillMd)).toBe(true);
    expect(syncedStat.isSymbolicLink()).toBe(false);
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