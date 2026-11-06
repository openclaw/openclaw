import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { expect, it, vi } from "vitest";
import pluginEntry from "./index.js";
import { makeContext, writeFile } from "./test/provider-helpers.js";

it("reports unreadable Claude skills before importing and allows a repaired retry", async () => {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-claude-skills-read-",
  });
  try {
    const source = path.join(workspace.dir, "project");
    const workspaceDir = path.join(workspace.dir, "target");
    const context = makeContext({
      source,
      workspaceDir,
      stateDir: path.join(workspace.dir, "state"),
    });
    const register = vi.fn<(provider: MigrationProviderPlugin) => void>();
    pluginEntry.register(createTestPluginApi({ registerMigrationProvider: register }));
    const provider = register.mock.calls[0]?.[0];
    if (!provider) {
      throw new Error("Claude migration provider was not registered");
    }
    await writeFile(path.join(source, "CLAUDE.md"), "# Instructions\n");
    const withoutSkills = await provider.plan(context);
    expect(withoutSkills.items.map((item) => item.kind)).toEqual(["workspace"]);

    const skillsDir = path.join(source, ".claude", "skills");
    const skill = path.join(skillsDir, "review", "SKILL.md");
    const content = "# Review carefully\n";
    await writeFile(skill, content);
    const failure = Object.assign(new Error(`EACCES: permission denied, scandir '${skillsDir}'`), {
      code: "EACCES",
      path: skillsDir,
    });
    const listing = vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure);
    try {
      await expect(provider.apply(context)).rejects.toMatchObject({
        code: "EACCES",
        path: skillsDir,
      });
    } finally {
      listing.mockRestore();
    }
    await expect(fs.access(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });

    const result = await provider.apply(context);
    expect(result.summary).toMatchObject({ migrated: 2, errors: 0 });
    expect(await fs.readFile(path.join(workspaceDir, "skills", "review", "SKILL.md"), "utf8")).toBe(
      content,
    );
    expect(await fs.readFile(skill, "utf8")).toBe(content);
  } finally {
    await workspace.cleanup();
  }
});
