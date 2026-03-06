import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPack } from "./install.js";

const fsp = fs.promises;

let tmpDir: string;
let packDir: string;
let targetDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pack-install-test-"));
  packDir = path.join(tmpDir, "source-pack");
  targetDir = path.join(tmpDir, "target-workspace");
  await fsp.mkdir(packDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function writePack(dir: string, frontmatter: string, body = "") {
  return fsp.writeFile(path.join(dir, "PACK.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
}

describe("installPack", () => {
  it("installs a basic pack with workspace files", async () => {
    await writePack(packDir, "name: basic-pack\nversion: 1.0.0");
    await fsp.writeFile(path.join(packDir, "SOUL.md"), "# My Soul", "utf-8");
    await fsp.writeFile(path.join(packDir, "AGENTS.md"), "# My Agents", "utf-8");

    const result = await installPack(packDir, { workdir: targetDir });
    expect(result.ok).toBe(true);
    expect(result.workspaceDir).toBe(targetDir);
    expect(result.copiedFiles).toContain("SOUL.md");
    expect(result.copiedFiles).toContain("AGENTS.md");
    expect(result.copiedFiles).toContain("PACK.md");

    const soul = await fsp.readFile(path.join(targetDir, "SOUL.md"), "utf-8");
    expect(soul).toBe("# My Soul");
  });

  it("processes template files by stripping .template extension", async () => {
    await writePack(packDir, "name: tpl-pack");
    await fsp.writeFile(path.join(packDir, "USER.md.template"), "# Customize me", "utf-8");

    const result = await installPack(packDir, { workdir: targetDir });
    expect(result.ok).toBe(true);
    expect(result.copiedFiles).toContain("USER.md");

    const user = await fsp.readFile(path.join(targetDir, "USER.md"), "utf-8");
    expect(user).toBe("# Customize me");
  });

  it("skips existing files without --force", async () => {
    await writePack(packDir, "name: skip-pack");
    await fsp.writeFile(path.join(packDir, "SOUL.md"), "# New Soul", "utf-8");

    // Pre-create target with existing file
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(path.join(targetDir, "SOUL.md"), "# Old Soul", "utf-8");

    const result = await installPack(packDir, { workdir: targetDir });
    expect(result.ok).toBe(true);
    expect(result.skippedFiles).toContain("SOUL.md");

    const soul = await fsp.readFile(path.join(targetDir, "SOUL.md"), "utf-8");
    expect(soul).toBe("# Old Soul");
  });

  it("overwrites existing files with --force", async () => {
    await writePack(packDir, "name: force-pack");
    await fsp.writeFile(path.join(packDir, "SOUL.md"), "# New Soul", "utf-8");

    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(path.join(targetDir, "SOUL.md"), "# Old Soul", "utf-8");

    const result = await installPack(packDir, { workdir: targetDir, force: true });
    expect(result.ok).toBe(true);
    expect(result.copiedFiles).toContain("SOUL.md");

    const soul = await fsp.readFile(path.join(targetDir, "SOUL.md"), "utf-8");
    expect(soul).toBe("# New Soul");
  });

  it("installs bundled skills", async () => {
    await writePack(packDir, "name: skill-pack");
    const skillDir = path.join(packDir, "skills", "my-skill");
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---", "utf-8");
    await fsp.writeFile(path.join(skillDir, "script.sh"), "#!/bin/bash\necho hi", "utf-8");

    const result = await installPack(packDir, { workdir: targetDir });
    expect(result.ok).toBe(true);
    expect(result.installedSkills).toContain("my-skill");

    const skillMd = await fsp.readFile(
      path.join(targetDir, "skills", "my-skill", "SKILL.md"),
      "utf-8",
    );
    expect(skillMd).toContain("my-skill");
  });

  it("skips skills with --skip-skills", async () => {
    await writePack(packDir, "name: no-skill-pack");
    const skillDir = path.join(packDir, "skills", "my-skill");
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---", "utf-8");

    const result = await installPack(packDir, { workdir: targetDir, skipSkills: true });
    expect(result.ok).toBe(true);
    expect(result.installedSkills).toEqual([]);
  });

  it("returns error for invalid pack directory", async () => {
    const result = await installPack(path.join(tmpDir, "nonexistent"), { workdir: targetDir });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("uses pack name as default workspace dir", async () => {
    await writePack(packDir, "name: auto-dir-pack");
    const result = await installPack(packDir);
    expect(result.ok).toBe(true);
    expect(result.workspaceDir).toContain("auto-dir-pack");
    // Cleanup
    await fsp.rm(result.workspaceDir, { recursive: true, force: true });
  });
});
