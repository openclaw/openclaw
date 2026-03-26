import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-meta-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("@mariozechner/pi-coding-agent");
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("loadWorkspaceSkillEntries metadata validation", () => {
  it("rejects loaded skills whose filePath is not a SKILL.md file", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const malformedBaseDir = path.join(workspaceDir, "skills", "malformed");
    await fs.mkdir(malformedBaseDir, { recursive: true });
    await fs.writeFile(path.join(malformedBaseDir, "SKILL.md"), "# placeholder\n", "utf-8");
    const nonSkillFile = path.join(malformedBaseDir, "README.md");
    await fs.writeFile(nonSkillFile, "# not a skill\n", "utf-8");

    vi.doMock("@mariozechner/pi-coding-agent", () => ({
      loadSkillsFromDir: () => ({
        skills: [
          {
            name: "malformed",
            description: "Malformed metadata",
            filePath: nonSkillFile,
            baseDir: malformedBaseDir,
            source: "openclaw-workspace",
          },
        ],
      }),
      formatSkillsForPrompt: () => "",
    }));

    const { loadWorkspaceSkillEntries } = await import("./skills.js");
    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries).toEqual([]);
  });

  it("rejects loaded skills whose baseDir does not match the SKILL.md parent directory", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const actualSkillDir = path.join(workspaceDir, "skills", "actual");
    const mismatchedBaseDir = path.join(workspaceDir, "skills", "other");
    await fs.mkdir(actualSkillDir, { recursive: true });
    await fs.mkdir(mismatchedBaseDir, { recursive: true });
    const skillFile = path.join(actualSkillDir, "SKILL.md");
    await fs.writeFile(skillFile, "# placeholder\n", "utf-8");

    vi.doMock("@mariozechner/pi-coding-agent", () => ({
      loadSkillsFromDir: () => ({
        skills: [
          {
            name: "mismatch",
            description: "Mismatched metadata",
            filePath: skillFile,
            baseDir: mismatchedBaseDir,
            source: "openclaw-workspace",
          },
        ],
      }),
      formatSkillsForPrompt: () => "",
    }));

    const { loadWorkspaceSkillEntries } = await import("./skills.js");
    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries).toEqual([]);
  });
});
