import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSkill } from "../skills.e2e-test-helpers.js";
import { loadWorkspaceSkillEntries } from "./workspace.js";

describe("allowExternalSkillsIn", () => {
  const tmpDirs: string[] = [];

  async function makeTmp(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function setupSymlinkedSkill() {
    // "external" dir holds the real skill files (simulates /nix/store or similar).
    const externalDir = await makeTmp("openclaw-external-skill-");
    await writeSkill({
      dir: path.join(externalDir, "my-ext-skill"),
      name: "my-ext-skill",
      description: "external skill",
    });

    // "workspace" dir uses a symlink that points outside itself.
    const workspaceDir = await makeTmp("openclaw-ws-");
    const extraSkillsDir = path.join(workspaceDir, "extra-skills");
    await fs.mkdir(extraSkillsDir, { recursive: true });
    await fs.symlink(
      path.join(externalDir, "my-ext-skill"),
      path.join(extraSkillsDir, "my-ext-skill"),
    );

    return { workspaceDir, extraSkillsDir, externalDir };
  }

  it("rejects symlinked skill outside root when allowExternalSkillsIn is not set", async () => {
    const { workspaceDir, extraSkillsDir } = await setupSymlinkedSkill();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [extraSkillsDir] },
        },
      },
      bundledSkillsDir: "__nonexistent__",
      managedSkillsDir: "__nonexistent__",
    });

    const names = entries.map((e) => e.skill.name);
    expect(names).not.toContain("my-ext-skill");
  });

  it("accepts symlinked skill when its real path matches allowExternalSkillsIn", async () => {
    const { workspaceDir, extraSkillsDir, externalDir } = await setupSymlinkedSkill();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          allowExternalSkillsIn: [externalDir],
          load: { extraDirs: [extraSkillsDir] },
        },
      },
      bundledSkillsDir: "__nonexistent__",
      managedSkillsDir: "__nonexistent__",
    });

    const names = entries.map((e) => e.skill.name);
    expect(names).toContain("my-ext-skill");
  });

  it("resolves symlink aliases in allowExternalSkillsIn prefixes", async () => {
    const { workspaceDir, extraSkillsDir, externalDir } = await setupSymlinkedSkill();

    // Create a symlink alias pointing to the external dir.
    const aliasDir = path.join(workspaceDir, "alias-to-external");
    await fs.symlink(externalDir, aliasDir);

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          // Use the symlink alias — must still match after canonicalization.
          allowExternalSkillsIn: [aliasDir],
          load: { extraDirs: [extraSkillsDir] },
        },
      },
      bundledSkillsDir: "__nonexistent__",
      managedSkillsDir: "__nonexistent__",
    });

    const names = entries.map((e) => e.skill.name);
    expect(names).toContain("my-ext-skill");
  });

  it("ignores empty-string entries in allowExternalSkillsIn", async () => {
    const { workspaceDir, extraSkillsDir } = await setupSymlinkedSkill();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          allowExternalSkillsIn: ["", "  "],
          load: { extraDirs: [extraSkillsDir] },
        },
      },
      bundledSkillsDir: "__nonexistent__",
      managedSkillsDir: "__nonexistent__",
    });

    const names = entries.map((e) => e.skill.name);
    expect(names).not.toContain("my-ext-skill");
  });
});
