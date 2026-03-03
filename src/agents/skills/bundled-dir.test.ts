import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { writeSkill } from "../skills.e2e-test-helpers.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";

describe("resolveBundledSkillsDir", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_SKILLS_DIR"]);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("returns OPENCLAW_BUNDLED_SKILLS_DIR override when set", async () => {
    const overrideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-override-"));
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = ` ${overrideDir} `;
    expect(resolveBundledSkillsDir()).toBe(overrideDir);
  });

  it("resolves bundled skills under a flattened dist layout", async () => {
    delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    await writeSkill({
      dir: path.join(root, "skills", "peekaboo"),
      name: "peekaboo",
      description: "peekaboo",
    });

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

  it("ignores a sibling 'skills' path that is not a valid skills dir (nvm symlink scenario)", async () => {
    delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sibling-"));

    // Create a sibling "skills" entry that looks like an unrelated CLI tool dir
    const fakeSkills = path.join(root, "skills");
    await fs.mkdir(fakeSkills, { recursive: true });
    // No .md files and no SKILL.md subdirectory — looksLikeSkillsDir should reject it

    const execPath = path.join(root, "node"); // sibling of fakeSkills
    await fs.writeFile(execPath, "#!/usr/bin/env node\n", "utf-8");

    // Provide a fallback moduleUrl/argv1 so it doesn't resolve anything from the real tree
    const resolved = resolveBundledSkillsDir({
      execPath,
      argv1: execPath,
      moduleUrl: pathToFileURL(execPath).href,
      cwd: root,
    });

    expect(resolved).toBeUndefined();
  });
});
