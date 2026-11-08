import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as tempRootModule from "../../infra/tmp-openclaw-dir.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";

describe("prepareClaudeCliSkillsPlugin", () => {
  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-claude-skills-test-" });
  let pluginTempRoot: string;
  let skillsSnapshot: SkillSnapshot;
  beforeEach(async () => {
    const base = await tempRoot.setup();
    pluginTempRoot = path.join(base, "tmp");
    const skillDir = path.join(base, "source", "demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(pluginTempRoot, { recursive: true });
    await fs.writeFile(skillFile, "# Demo\n", "utf8");
    const skill = createCanonicalFixtureSkill({
      name: "demo",
      description: "Demo skill",
      filePath: skillFile,
      baseDir: skillDir,
      source: "openclaw-workspace",
    });
    skillsSnapshot = { prompt: "demo", skills: [{ name: "demo" }], resolvedSkills: [skill] };
    vi.spyOn(tempRootModule, "resolvePreferredOpenClawTmpDir").mockReturnValue(pluginTempRoot);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await tempRoot.cleanup();
  });

  it.each(["mkdir", "writeFile"] as const)("cleans up when %s fails", async (operation) => {
    const error = new Error("filesystem unavailable");
    vi.spyOn(fs, operation).mockRejectedValueOnce(error);
    await expect(
      prepareClaudeCliSkillsPlugin({ backendId: "claude-cli", skillsSnapshot }),
    ).rejects.toBe(error);
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });

  it.each(["linked", "copied", "empty"])("delivers mixed skills (%s)", async (mode) => {
    const nodeDir = "node://node-a/skills/remote-demo";
    const remote = {
      ...createCanonicalFixtureSkill({
        name: "remote-demo",
        description: "Remote skill",
        filePath: `${nodeDir}/SKILL.md`,
        baseDir: nodeDir,
        source: "openclaw-node",
      }),
      readContent: mode === "empty" ? " " : "# Remote Demo\n",
      locationNote: "exec host=node node=node-a",
    };
    if (mode === "copied") {
      vi.spyOn(fs, "symlink").mockRejectedValueOnce(new Error("unavailable"));
    }
    const prepared = await prepareClaudeCliSkillsPlugin({
      backendId: "claude-cli",
      skillsSnapshot: {
        ...skillsSnapshot,
        resolvedSkills: mode === "empty" ? [remote] : [...skillsSnapshot.resolvedSkills!, remote],
      },
    });
    try {
      if (mode === "empty") {
        expect(prepared.args).toEqual([]);
        expect(prepared.pluginDir).toBeUndefined();
      } else {
        const skillsDir = path.join(prepared.pluginDir!, "skills");
        const localDir = path.join(skillsDir, "demo");
        expect(await fs.readFile(path.join(skillsDir, "remote-demo", "SKILL.md"), "utf8")).toBe(
          "# Remote Demo\n\nexec host=node node=node-a\n",
        );
        expect(prepared.skillCommands?.get("openclaw-skills:remote-demo")).toBe(remote);
        expect(await fs.readFile(path.join(localDir, "SKILL.md"), "utf8")).toBe("# Demo\n");
        expect((await fs.lstat(localDir)).isSymbolicLink()).toBe(mode === "linked");
      }
    } finally {
      await prepared.cleanup();
    }
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });
});
