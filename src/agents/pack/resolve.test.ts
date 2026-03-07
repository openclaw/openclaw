import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePack, scanPacksDir } from "./resolve.js";

const fsp = fs.promises;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pack-resolve-test-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function writePack(dir: string, frontmatter: string, body = "") {
  return fsp.writeFile(path.join(dir, "PACK.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
}

describe("resolvePack", () => {
  it("resolves a valid pack with workspace files", async () => {
    await writePack(tmpDir, "name: test-pack\nversion: 1.0.0", "# Test Pack");
    await fsp.writeFile(path.join(tmpDir, "SOUL.md"), "# Soul", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "AGENTS.md"), "# Agents", "utf-8");

    const pack = await resolvePack(tmpDir);
    expect(pack).toBeDefined();
    expect(pack!.metadata.name).toBe("test-pack");
    expect(pack!.metadata.version).toBe("1.0.0");
    expect(pack!.workspaceFiles).toContain("SOUL.md");
    expect(pack!.workspaceFiles).toContain("AGENTS.md");
    expect(pack!.description).toBe("# Test Pack");
  });

  it("detects template files", async () => {
    await writePack(tmpDir, "name: tpl-pack");
    await fsp.writeFile(path.join(tmpDir, "USER.md.template"), "# User", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "TOOLS.md.template"), "# Tools", "utf-8");

    const pack = await resolvePack(tmpDir);
    expect(pack).toBeDefined();
    expect(pack!.templateFiles).toContain("USER.md.template");
    expect(pack!.templateFiles).toContain("TOOLS.md.template");
  });

  it("detects bundled skills", async () => {
    await writePack(tmpDir, "name: skill-pack");
    const skillDir = path.join(tmpDir, "skills", "my-skill");
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---", "utf-8");

    const pack = await resolvePack(tmpDir);
    expect(pack).toBeDefined();
    expect(pack!.bundledSkillDirs).toContain("my-skill");
  });

  it("skips skills dirs without SKILL.md", async () => {
    await writePack(tmpDir, "name: no-skill-pack");
    const badSkillDir = path.join(tmpDir, "skills", "not-a-skill");
    await fsp.mkdir(badSkillDir, { recursive: true });
    await fsp.writeFile(path.join(badSkillDir, "readme.txt"), "hi", "utf-8");

    const pack = await resolvePack(tmpDir);
    expect(pack).toBeDefined();
    expect(pack!.bundledSkillDirs).toEqual([]);
  });

  it("returns undefined for missing PACK.md", async () => {
    const pack = await resolvePack(tmpDir);
    expect(pack).toBeUndefined();
  });

  it("returns undefined for PACK.md without name", async () => {
    await writePack(tmpDir, "description: no name here");
    const pack = await resolvePack(tmpDir);
    expect(pack).toBeUndefined();
  });

  it("returns undefined for non-existent directory", async () => {
    const pack = await resolvePack(path.join(tmpDir, "nope"));
    expect(pack).toBeUndefined();
  });

  it("does not include PACK.md as workspace file", async () => {
    await writePack(tmpDir, "name: meta-pack");
    const pack = await resolvePack(tmpDir);
    expect(pack).toBeDefined();
    expect(pack!.workspaceFiles).not.toContain("PACK.md");
  });
});

describe("scanPacksDir", () => {
  it("scans a directory for packs", async () => {
    const packA = path.join(tmpDir, "pack-a");
    const packB = path.join(tmpDir, "pack-b");
    await fsp.mkdir(packA, { recursive: true });
    await fsp.mkdir(packB, { recursive: true });
    await writePack(packA, "name: pack-a\nversion: 1.0.0");
    await writePack(packB, "name: pack-b\nversion: 2.0.0");

    const packs = await scanPacksDir(tmpDir);
    expect(packs).toHaveLength(2);
    const names = packs.map((p) => p.metadata.name).toSorted();
    expect(names).toEqual(["pack-a", "pack-b"]);
  });

  it("returns empty array for empty directory", async () => {
    const packs = await scanPacksDir(tmpDir);
    expect(packs).toEqual([]);
  });

  it("skips directories without PACK.md", async () => {
    const noPackDir = path.join(tmpDir, "not-a-pack");
    await fsp.mkdir(noPackDir, { recursive: true });
    await fsp.writeFile(path.join(noPackDir, "README.md"), "hi", "utf-8");

    const packs = await scanPacksDir(tmpDir);
    expect(packs).toEqual([]);
  });

  it("returns empty array for non-existent directory", async () => {
    const packs = await scanPacksDir(path.join(tmpDir, "nope"));
    expect(packs).toEqual([]);
  });
});
