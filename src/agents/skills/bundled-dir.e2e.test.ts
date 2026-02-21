import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBundledSkillsDir } from "./bundled-dir.js";

async function writeSkill(dir: string, name: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`,
    "utf-8",
  );
}

describe("resolveBundledSkillsDir", () => {
  const originalOverride = process.env.OPENCLAW_BUNDLED_SKILLS_DIR;

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_SKILLS_DIR = originalOverride;
    }
  });

  it("resolves bundled skills under a flattened dist layout", async () => {
    delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    await writeSkill(path.join(root, "skills", "peekaboo"), "peekaboo");

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const argv1 = path.join(distDir, "index.js");
    await fs.writeFile(argv1, "// stub", "utf-8");

    const moduleUrl = pathToFileURL(path.join(distDir, "skills.js")).href;
    const execPath = path.join(root, "bin", "node");
    await fs.mkdir(path.dirname(execPath), { recursive: true });

    const resolved = resolveBundledSkillsDir({
      argv1,
      moduleUrl,
      cwd: distDir,
      execPath,
    });

    expect(resolved).toBe(path.join(root, "skills"));
  });
});
