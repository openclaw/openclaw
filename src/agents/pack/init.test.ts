import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initPack } from "./init.js";

const fsp = fs.promises;

let tmpDir: string;
let workspaceDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pack-init-test-"));
  workspaceDir = path.join(tmpDir, "my-workspace");
  await fsp.mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("initPack", () => {
  it("creates a pack with PACK.md", async () => {
    const outputDir = path.join(tmpDir, "output-pack");
    const result = await initPack(workspaceDir, {
      name: "test-pack",
      outputDir,
      description: "A test pack",
      author: "tester",
      version: "1.0.0",
    });

    expect(result.ok).toBe(true);
    expect(result.packDir).toBe(outputDir);
    expect(result.files).toContain("PACK.md");

    const packMd = await fsp.readFile(path.join(outputDir, "PACK.md"), "utf-8");
    expect(packMd).toContain("name: test-pack");
    expect(packMd).toContain("description: A test pack");
    expect(packMd).toContain("author: tester");
    expect(packMd).toContain("version: 1.0.0");
  });

  it("copies workspace files", async () => {
    await fsp.writeFile(path.join(workspaceDir, "SOUL.md"), "# My Soul", "utf-8");
    await fsp.writeFile(path.join(workspaceDir, "AGENTS.md"), "# My Agents", "utf-8");

    const outputDir = path.join(tmpDir, "output-pack");
    const result = await initPack(workspaceDir, { name: "ws-pack", outputDir });

    expect(result.ok).toBe(true);
    expect(result.files).toContain("SOUL.md");
    expect(result.files).toContain("AGENTS.md");

    const soul = await fsp.readFile(path.join(outputDir, "SOUL.md"), "utf-8");
    expect(soul).toBe("# My Soul");
  });

  it("creates .template versions of user-specific files", async () => {
    await fsp.writeFile(path.join(workspaceDir, "USER.md"), "# My User", "utf-8");
    await fsp.writeFile(path.join(workspaceDir, "TOOLS.md"), "# My Tools", "utf-8");

    const outputDir = path.join(tmpDir, "output-pack");
    const result = await initPack(workspaceDir, { name: "tpl-pack", outputDir });

    expect(result.ok).toBe(true);
    expect(result.files).toContain("USER.md.template");
    expect(result.files).toContain("TOOLS.md.template");

    const userTpl = await fsp.readFile(path.join(outputDir, "USER.md.template"), "utf-8");
    expect(userTpl).toBe("# My User");
  });

  it("includes skills when --include-skills", async () => {
    const skillDir = path.join(workspaceDir, "skills", "my-skill");
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---", "utf-8");

    const outputDir = path.join(tmpDir, "output-pack");
    const result = await initPack(workspaceDir, {
      name: "skill-pack",
      outputDir,
      includeSkills: true,
    });

    expect(result.ok).toBe(true);
    expect(result.files).toContain("skills/my-skill");

    const skillMd = await fsp.readFile(
      path.join(outputDir, "skills", "my-skill", "SKILL.md"),
      "utf-8",
    );
    expect(skillMd).toContain("my-skill");
  });

  it("does not include skills without --include-skills", async () => {
    const skillDir = path.join(workspaceDir, "skills", "my-skill");
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---", "utf-8");

    const outputDir = path.join(tmpDir, "output-pack");
    const result = await initPack(workspaceDir, {
      name: "no-skill-pack",
      outputDir,
    });

    expect(result.ok).toBe(true);
    expect(result.files).not.toContain("skills/my-skill");
  });

  it("uses default output dir based on pack name", async () => {
    const result = await initPack(workspaceDir, { name: "auto-dir" });
    expect(result.ok).toBe(true);
    expect(result.packDir).toContain("auto-dir-pack");
    // Cleanup
    await fsp.rm(result.packDir, { recursive: true, force: true });
  });

  it("skips non-existent workspace files gracefully", async () => {
    const outputDir = path.join(tmpDir, "output-pack");
    const result = await initPack(workspaceDir, { name: "empty-pack", outputDir });

    expect(result.ok).toBe(true);
    expect(result.files).toContain("PACK.md");
    // No SOUL.md, AGENTS.md, etc. in the empty workspace
    expect(result.files).not.toContain("SOUL.md");
  });

  it("generates correct PACK.md frontmatter", async () => {
    const outputDir = path.join(tmpDir, "output-pack");
    await initPack(workspaceDir, {
      name: "frontmatter-test",
      outputDir,
      description: "Testing frontmatter generation",
      author: "xiaoc",
      version: "2.5.0",
    });

    const content = await fsp.readFile(path.join(outputDir, "PACK.md"), "utf-8");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("name: frontmatter-test");
    expect(content).toContain("version: 2.5.0");
    expect(content).toContain("# frontmatter-test");
  });
});
