import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillSnapshot } from "../skills.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";

describe("prepareClaudeCliSkillsPlugin backend gate", () => {
  let fixtureDir: string;
  let snapshot: SkillSnapshot;
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-skills-gate-"));
    const skillDir = path.join(fixtureDir, "demo-skill");
    await mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    await writeFile(skillFile, "# demo skill\n");
    snapshot = {
      prompt: "",
      skills: [{ name: "demo-skill" }],
      resolvedSkills: [{ name: "demo-skill", filePath: skillFile }],
    } as unknown as SkillSnapshot;
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("materializes the skills plugin for claude-cli", async () => {
    const result = await prepareClaudeCliSkillsPlugin({
      backendId: "claude-cli",
      skillsSnapshot: snapshot,
    });
    cleanups.push(result.cleanup);
    expect(result.args).toEqual(["--plugin-dir", expect.any(String)]);
  });

  // The fix: claude-cli-interactive runs the same Claude CLI, so it must receive
  // the same skills plugin. A claude-cli-only gate previously dropped its skills.
  it("materializes the skills plugin for claude-cli-interactive", async () => {
    const result = await prepareClaudeCliSkillsPlugin({
      backendId: "claude-cli-interactive",
      skillsSnapshot: snapshot,
    });
    cleanups.push(result.cleanup);
    expect(result.args).toEqual(["--plugin-dir", expect.any(String)]);
  });

  it("returns no plugin args for a non-Claude backend", async () => {
    const result = await prepareClaudeCliSkillsPlugin({
      backendId: "codex-cli",
      skillsSnapshot: snapshot,
    });
    cleanups.push(result.cleanup);
    expect(result.args).toEqual([]);
  });
});
