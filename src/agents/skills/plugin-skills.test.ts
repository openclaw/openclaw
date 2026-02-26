import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginManifestRegistry } from "../../plugins/manifest-registry.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

const hoisted = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => hoisted.loadPluginManifestRegistry(...args),
}));

const { resolvePluginSkillDirs } = await import("./plugin-skills.js");

const tempDirs = createTrackedTempDirs();

function buildRegistry(params: { acpxRoot: string; helperRoot: string }): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "acpx",
        name: "ACPX Runtime",
        channels: [],
        providers: [],
        skills: ["./skills"],
        origin: "workspace",
        rootDir: params.acpxRoot,
        source: params.acpxRoot,
        manifestPath: path.join(params.acpxRoot, "openclaw.plugin.json"),
      },
      {
        id: "helper",
        name: "Helper",
        channels: [],
        providers: [],
        skills: ["./skills"],
        origin: "workspace",
        rootDir: params.helperRoot,
        source: params.helperRoot,
        manifestPath: path.join(params.helperRoot, "openclaw.plugin.json"),
      },
    ],
  };
}

afterEach(async () => {
  hoisted.loadPluginManifestRegistry.mockReset();
  await tempDirs.cleanup();
});

describe("resolvePluginSkillDirs", () => {
  it("keeps acpx plugin skills when ACP is enabled", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const acpxRoot = await tempDirs.make("openclaw-acpx-plugin-");
    const helperRoot = await tempDirs.make("openclaw-helper-plugin-");
    await fs.mkdir(path.join(acpxRoot, "skills"), { recursive: true });
    await fs.mkdir(path.join(helperRoot, "skills"), { recursive: true });

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      buildRegistry({
        acpxRoot,
        helperRoot,
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        acp: { enabled: true },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([path.resolve(acpxRoot, "skills"), path.resolve(helperRoot, "skills")]);
  });

  it("skips acpx plugin skills when ACP is disabled", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const acpxRoot = await tempDirs.make("openclaw-acpx-plugin-");
    const helperRoot = await tempDirs.make("openclaw-helper-plugin-");
    await fs.mkdir(path.join(acpxRoot, "skills"), { recursive: true });
    await fs.mkdir(path.join(helperRoot, "skills"), { recursive: true });

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      buildRegistry({
        acpxRoot,
        helperRoot,
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        acp: { enabled: false },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([path.resolve(helperRoot, "skills")]);
  });
});
