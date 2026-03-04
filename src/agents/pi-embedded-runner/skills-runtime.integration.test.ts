import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearPluginManifestRegistryCache } from "../../plugins/manifest-registry.js";
import { resolveEmbeddedRunSkillEntries } from "./skills-runtime.js";

const tempDirs: string[] = [];
const originalBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

async function createTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupBundledDiffsPlugin() {
  const bundledPluginsDir = await createTempDir("openclaw-bundled-");
  const workspaceDir = await createTempDir("openclaw-workspace-");
  const pluginRoot = path.join(bundledPluginsDir, "diffs");

  await fs.mkdir(path.join(pluginRoot, "skills", "diffs"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "diffs",
        skills: ["./skills"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    ),
    "utf-8",
  );
  await fs.writeFile(path.join(pluginRoot, "index.ts"), "export {};\n", "utf-8");
  await fs.writeFile(
    path.join(pluginRoot, "skills", "diffs", "SKILL.md"),
    `---\nname: diffs\ndescription: runtime integration test\n---\n`,
    "utf-8",
  );

  return { bundledPluginsDir, workspaceDir };
}

afterEach(async () => {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledDir;
  clearPluginManifestRegistryCache();
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("resolveEmbeddedRunSkillEntries (integration)", () => {
  it("loads bundled diffs skill when explicitly enabled in config", async () => {
    const { bundledPluginsDir, workspaceDir } = await setupBundledDiffsPlugin();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    clearPluginManifestRegistryCache();

    const config: OpenClawConfig = {
      plugins: {
        entries: {
          diffs: { enabled: true },
        },
      },
    };

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir,
      config,
    });

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(result.skillEntries.map((entry) => entry.skill.name)).toContain("diffs");
  });

  it("skips bundled diffs skill when config is missing", async () => {
    const { bundledPluginsDir, workspaceDir } = await setupBundledDiffsPlugin();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    clearPluginManifestRegistryCache();

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir,
    });

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(result.skillEntries.map((entry) => entry.skill.name)).not.toContain("diffs");
  });
});
