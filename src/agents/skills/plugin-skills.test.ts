import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginManifestRegistry } from "../../plugins/manifest-registry.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

const hoisted = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => hoisted.loadPluginManifestRegistry(...args),
}));

let resolvePluginSkillDirs: typeof import("./plugin-skills.js").resolvePluginSkillDirs;

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
        hooks: [],
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
        hooks: [],
        origin: "workspace",
        rootDir: params.helperRoot,
        source: params.helperRoot,
        manifestPath: path.join(params.helperRoot, "openclaw.plugin.json"),
      },
    ],
  };
}

function createSinglePluginRegistry(params: {
  pluginRoot: string;
  skills: string[];
  format?: "openclaw" | "bundle";
  legacyPluginIds?: string[];
}): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "helper",
        name: "Helper",
        format: params.format,
        channels: [],
        providers: [],
        legacyPluginIds: params.legacyPluginIds,
        skills: params.skills,
        hooks: [],
        origin: "workspace",
        rootDir: params.pluginRoot,
        source: params.pluginRoot,
        manifestPath: path.join(params.pluginRoot, "openclaw.plugin.json"),
      },
    ],
  };
}

async function setupAcpxAndHelperRegistry() {
  const workspaceDir = await tempDirs.make("openclaw-");
  const acpxRoot = await tempDirs.make("openclaw-acpx-plugin-");
  const helperRoot = await tempDirs.make("openclaw-helper-plugin-");
  await fs.mkdir(path.join(acpxRoot, "skills"), { recursive: true });
  await fs.mkdir(path.join(helperRoot, "skills"), { recursive: true });
  hoisted.loadPluginManifestRegistry.mockReturnValue(buildRegistry({ acpxRoot, helperRoot }));
  return { workspaceDir, acpxRoot, helperRoot };
}

async function setupPluginOutsideSkills() {
  const workspaceDir = await tempDirs.make("openclaw-");
  const pluginRoot = await tempDirs.make("openclaw-plugin-");
  const outsideDir = await tempDirs.make("openclaw-outside-");
  const outsideSkills = path.join(outsideDir, "skills");
  return { workspaceDir, pluginRoot, outsideSkills };
}

async function setupBundledRuntimeOverlayPlugin() {
  const workspaceDir = await tempDirs.make("openclaw-");
  const packageRoot = await tempDirs.make("openclaw-package-");
  const builtPluginRoot = path.join(packageRoot, "dist", "extensions", "helper");
  const runtimePluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "helper");
  await fs.mkdir(path.join(builtPluginRoot, "skills"), { recursive: true });
  await fs.mkdir(path.join(runtimePluginRoot, "skills"), { recursive: true });
  return { workspaceDir, builtPluginRoot, runtimePluginRoot };
}

afterEach(async () => {
  hoisted.loadPluginManifestRegistry.mockReset();
  await tempDirs.cleanup();
});

describe("resolvePluginSkillDirs", () => {
  beforeAll(async () => {
    ({ resolvePluginSkillDirs } = await import("./plugin-skills.js"));
  });

  beforeEach(() => {
    hoisted.loadPluginManifestRegistry.mockReset();
  });

  it.each([
    {
      name: "keeps acpx plugin skills when ACP is enabled",
      acpEnabled: true,
      expectedDirs: ({ acpxRoot, helperRoot }: { acpxRoot: string; helperRoot: string }) => [
        path.resolve(acpxRoot, "skills"),
        path.resolve(helperRoot, "skills"),
      ],
    },
    {
      name: "skips acpx plugin skills when ACP is disabled",
      acpEnabled: false,
      expectedDirs: ({ helperRoot }: { acpxRoot: string; helperRoot: string }) => [
        path.resolve(helperRoot, "skills"),
      ],
    },
  ])("$name", async ({ acpEnabled, expectedDirs }) => {
    const { workspaceDir, acpxRoot, helperRoot } = await setupAcpxAndHelperRegistry();

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        acp: { enabled: acpEnabled },
        plugins: {
          entries: {
            acpx: { enabled: true },
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual(expectedDirs({ acpxRoot, helperRoot }));
  });

  it("rejects plugin skill paths that escape the plugin root", async () => {
    const { workspaceDir, pluginRoot, outsideSkills } = await setupPluginOutsideSkills();
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await fs.mkdir(outsideSkills, { recursive: true });
    const escapePath = path.relative(pluginRoot, outsideSkills);

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        skills: ["./skills", escapePath],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([path.resolve(pluginRoot, "skills")]);
  });

  it("rejects plugin skill symlinks that resolve outside plugin root", async () => {
    const { workspaceDir, pluginRoot, outsideSkills } = await setupPluginOutsideSkills();
    const linkPath = path.join(pluginRoot, "skills-link");
    await fs.mkdir(outsideSkills, { recursive: true });
    await fs.symlink(
      outsideSkills,
      linkPath,
      process.platform === "win32" ? ("junction" as const) : ("dir" as const),
    );

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        skills: ["./skills-link"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([]);
  });

  it("resolves Claude bundle command roots through the normal plugin skill path", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const pluginRoot = await tempDirs.make("openclaw-claude-bundle-");
    await fs.mkdir(path.join(pluginRoot, "commands"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        format: "bundle",
        skills: ["./skills", "./commands"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([
      path.resolve(pluginRoot, "skills"),
      path.resolve(pluginRoot, "commands"),
    ]);
  });

  it("prefers built skill roots over dist-runtime overlay paths", async () => {
    const { workspaceDir, builtPluginRoot, runtimePluginRoot } =
      await setupBundledRuntimeOverlayPlugin();

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot: runtimePluginRoot,
        skills: ["./skills"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([path.resolve(builtPluginRoot, "skills")]);
  });

  it("does not remap when dist-runtime appears as a partial segment", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    // Dir name contains "dist-runtime" as a substring, not a full segment.
    const fakeRoot = await tempDirs.make("openclaw-mydist-runtime-");
    const pluginRoot = path.join(fakeRoot, "extensions", "helper");
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        skills: ["./skills"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([path.resolve(pluginRoot, "skills")]);
  });

  it("does not remap when plugin rootDir is outside the dist-runtime/extensions subtree", async () => {
    // A non-bundled plugin whose resolved skill path accidentally contains
    // /dist-runtime/extensions/ should not be remapped, even if the dist/
    // counterpart exists on disk.
    const workspaceDir = await tempDirs.make("openclaw-");
    const packageRoot = await tempDirs.make("openclaw-package-");
    // Plugin root is directly inside package root, NOT under dist-runtime/extensions.
    const pluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "helper");
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    // Create a dist/ counterpart that would be used if remap incorrectly fires.
    const distSkills = path.join(packageRoot, "dist", "extensions", "helper", "skills");
    await fs.mkdir(distSkills, { recursive: true });

    // Register the plugin with rootDir pointing to a DIFFERENT location
    // (outside the dist-runtime subtree) but whose skill path resolves
    // through the dist-runtime/extensions segment.
    const externalRoot = await tempDirs.make("openclaw-external-");
    const externalSkillsDir = path.join(pluginRoot, "skills");
    // Use the external root as the plugin rootDir but point skills at the
    // dist-runtime-containing path via a symlink.
    const linkedSkills = path.join(externalRoot, "skills");
    await fs.symlink(externalSkillsDir, linkedSkills);

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot: externalRoot,
        skills: ["./skills"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    // The symlink resolves outside externalRoot, so containment rejects it.
    expect(dirs).toEqual([]);
  });

  it("does not remap when rootDir is not under the matched dist-runtime subtree", async () => {
    // Plugin rootDir is a standalone directory that happens to contain
    // dist-runtime/extensions as path segments in its skill path but the
    // rootDir itself is not under that subtree.
    const workspaceDir = await tempDirs.make("openclaw-");
    const fakePackage = await tempDirs.make("openclaw-fake-pkg-");
    const pluginRoot = path.join(fakePackage, "dist-runtime", "extensions", "helper");
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    // Create dist counterpart that would match if remap fires.
    await fs.mkdir(path.join(fakePackage, "dist", "extensions", "helper", "skills"), {
      recursive: true,
    });

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        // rootDir IS the dist-runtime subtree, so this should still remap.
        pluginRoot,
        skills: ["./skills"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    // rootDir is under dist-runtime/extensions, so remap is valid.
    expect(dirs).toEqual([path.resolve(fakePackage, "dist", "extensions", "helper", "skills")]);
  });

  it("falls back to dist-runtime path when dist counterpart does not exist", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const packageRoot = await tempDirs.make("openclaw-package-");
    const runtimePluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "helper");
    await fs.mkdir(path.join(runtimePluginRoot, "skills"), { recursive: true });
    // No dist/extensions/helper/skills created — dist counterpart missing.

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot: runtimePluginRoot,
        skills: ["./skills"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([path.resolve(runtimePluginRoot, "skills")]);
  });

  it("rejects remapped built path when it symlinks outside plugin root", async () => {
    const { workspaceDir, builtPluginRoot, runtimePluginRoot } =
      await setupBundledRuntimeOverlayPlugin();

    // Replace the built skills dir with a symlink pointing outside the plugin root.
    const outsideDir = await tempDirs.make("openclaw-outside-");
    const builtSkills = path.join(builtPluginRoot, "skills");
    await fs.rm(builtSkills, { recursive: true });
    await fs.symlink(outsideDir, builtSkills);

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot: runtimePluginRoot,
        skills: ["./skills"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([]);
  });

  it("rejects remapped built path when it symlinks to a sibling plugin", async () => {
    const { workspaceDir, builtPluginRoot, runtimePluginRoot } =
      await setupBundledRuntimeOverlayPlugin();

    // Create a sibling plugin's skills dir under the same package.
    const packageRoot = path.dirname(path.dirname(builtPluginRoot));
    const siblingSkills = path.join(packageRoot, "extensions", "other-plugin", "skills");
    await fs.mkdir(siblingSkills, { recursive: true });

    // Replace the built skills dir with a symlink to the sibling.
    const builtSkills = path.join(builtPluginRoot, "skills");
    await fs.rm(builtSkills, { recursive: true });
    await fs.symlink(siblingSkills, builtSkills);

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot: runtimePluginRoot,
        skills: ["./skills"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([]);
  });

  it("rejects remapped built path when built plugin root symlinks outside package", async () => {
    const { workspaceDir, builtPluginRoot, runtimePluginRoot } =
      await setupBundledRuntimeOverlayPlugin();

    // Create a dir outside the package and symlink the built plugin root to it.
    const outsideDir = await tempDirs.make("openclaw-outside-plugin-");
    await fs.mkdir(path.join(outsideDir, "skills"), { recursive: true });
    await fs.rm(builtPluginRoot, { recursive: true });
    await fs.symlink(outsideDir, builtPluginRoot);

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot: runtimePluginRoot,
        skills: ["./skills"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([]);
  });

  it("resolves enabled plugin skills through legacy manifest aliases", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const pluginRoot = await tempDirs.make("openclaw-legacy-plugin-");
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });

    hoisted.loadPluginManifestRegistry.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        skills: ["./skills"],
        legacyPluginIds: ["helper-legacy"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            "helper-legacy": { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([path.resolve(pluginRoot, "skills")]);
  });
});
