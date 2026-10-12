import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { recordSkillFileHost } from "../skills/skill-file-host.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { prepareInstalledSkillCatalog } from "./installed-skill-runtime.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

afterEach(resetCodeModeTestState);

it("returns a local companion through the worker and withholds replaced or denied roots", async () => {
  await withTempDir("code-mode-companion-", async (directory) => {
    const dir = await realpath(directory);
    const root = path.join(dir, "guide");
    await mkdir(root);
    const filePath = path.join(root, "SKILL.md");
    await writeFile(filePath, "Whole instructions");
    await writeFile(path.join(root, "companion.md"), "Selected companion");
    const guide = createFixtureSkillEntry("guide");
    Object.assign(guide.skill, { filePath, baseDir: root });
    recordSkillFileHost(guide.skill, "gateway");
    const skills = prepareInstalledSkillCatalog({
      workspaceDir: dir,
      snapshot: { prompt: "", skills: [{ name: "guide" }], discoverySkills: [guide.skill] },
    });
    const h = createCodeModeHarness({ codeModeSkills: skills });
    const nativeTools = createInstalledSkillTools(skills);
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, ...nativeTools] });
    const run = (code: string) =>
      runUntilCompleted({
        execTool: h.tools[0]!,
        waitTool: h.tools[1]!,
        code,
      });
    const allowed = await run(
      'return { whole: await skills.read("guide"), companion: await skills.read("guide", "companion.md") };',
    );
    expect(allowed).toMatchObject({
      status: "completed",
      value: {
        whole: "Whole instructions",
        companion: "Selected companion",
      },
    });
    await rename(root, `${root}-original`);
    await mkdir(root);
    await writeFile(path.join(root, "companion.md"), "Replacement marker");
    const rejected = await run(
      'try { return await skills.read("guide", "companion.md"); } catch (error) { return { rejected: true, message: error.message }; }',
    );
    expect(rejected).toMatchObject({ status: "completed", value: { rejected: true } });
    expect(JSON.stringify(rejected)).not.toContain("Replacement marker");
    applyCodeModeCatalog({
      ...h.ctx,
      tools: [...h.tools, ...nativeTools.filter((tool) => tool.name !== "skills_read")],
    });
    const denied = await run(
      'try { return await skills.read("guide", "companion.md"); } catch (error) { return error.message; }',
    );
    expect(denied).toMatchObject({
      status: "completed",
      value: "skills_read is not available in this run.",
    });
  });
});
