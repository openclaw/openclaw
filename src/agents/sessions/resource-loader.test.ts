// Resource loader tests cover prompt loading and transforms.
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withMockedWindowsPlatform } from "../../test-utils/vitest-spies.js";
import darkTheme from "../modes/interactive/theme/dark.json" with { type: "json" };
import { clearExtensionCache } from "./extensions/loader.js";
import type { ExtensionFactory } from "./extensions/types.js";
import { DefaultPackageManager } from "./package-manager.js";
import { loadPromptTemplates } from "./prompt-templates.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SettingsManager } from "./settings-manager.js";
import type { SourceScope } from "./source-info.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ExtensionCacheTestState = {
  factoryRuns: number;
  moduleLoads: number;
};

function extensionCacheTestState(): ExtensionCacheTestState {
  return (
    globalThis as typeof globalThis & { openclawExtensionCacheTestState: ExtensionCacheTestState }
  ).openclawExtensionCacheTestState;
}

function extensionSource(command: string): string {
  return `
const state = (globalThis.openclawExtensionCacheTestState ??= { factoryRuns: 0, moduleLoads: 0 });
state.moduleLoads += 1;

export default function extension(api) {
  state.factoryRuns += 1;
  api.registerCommand(${JSON.stringify(command)}, {
    description: "cache probe",
    handler() {},
  });
}
`;
}

function sourceMetadata(path: string, source: string, scope: SourceScope) {
  return { path, source, scope, origin: "package" as const, baseDir: path };
}

afterEach(() => {
  clearExtensionCache();
  Reflect.deleteProperty(globalThis, "openclawExtensionCacheTestState");
});

describe("DefaultResourceLoader", () => {
  it("does not load a direct local extension disabled by its package filter", async () => {
    const root = tempDirs.make("openclaw-resource-loader-filter-");
    const extensionPath = join(root, "extension.ts");
    await writeFile(extensionPath, "export default function extension() {}\n");
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({
        packages: [{ source: extensionPath, extensions: [] }],
      }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();

    expect(loader.getExtensions().extensions).toEqual([]);
  });

  it("skips ambient package resolution while preserving explicit resource paths", async () => {
    const root = tempDirs.make("openclaw-resource-loader-explicit-");
    const promptDir = join(root, "explicit-prompts");
    const promptPath = join(promptDir, "explicit.md");
    await mkdir(promptDir);
    await writeFile(promptPath, "Explicit prompt");
    const resolvePackages = vi.spyOn(DefaultPackageManager.prototype, "resolve");

    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        additionalPromptTemplatePaths: [promptDir],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

      await loader.reload();

      expect(resolvePackages).not.toHaveBeenCalled();
      expect(loader.getPrompts().prompts).toEqual([
        expect.objectContaining({ name: "explicit", filePath: promptPath }),
      ]);
    } finally {
      resolvePackages.mockRestore();
    }
  });

  it("loads only immediate resource files while preserving linked path spelling", async () => {
    const root = tempDirs.make("openclaw-resource-discovery-");
    const resources = join(root, "resources");
    const alias = join(root, "linked-resources");
    const nested = join(resources, "nested");
    await mkdir(nested, { recursive: true });
    await symlink(resources, alias, process.platform === "win32" ? "junction" : "dir");
    await symlink(
      nested,
      join(resources, "linked-directory"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const { extension, content } of [
      { extension: "md", content: (name: string) => `# ${name}\n` },
      { extension: "json", content: (name: string) => JSON.stringify({ ...darkTheme, name }) },
    ]) {
      for (const name of ["regular", ".hidden"]) {
        await writeFile(join(resources, `${name}.${extension}`), content(name));
      }
      await writeFile(join(nested, `nested.${extension}`), content("nested"));
      await writeFile(
        join(resources, `uppercase.${extension.toUpperCase()}`),
        content("uppercase"),
      );
      const target = join(root, `target.${extension}`);
      await writeFile(target, content("linked"));
      await symlink(target, join(resources, `linked.${extension}`), "file");
      await symlink(join(root, "absent"), join(resources, `broken.${extension}`), "file");
    }
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory(),
      additionalPromptTemplatePaths: [alias],
      additionalThemePaths: [alias],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();

    const expectedNames = [".hidden", "linked", "regular"];
    expect(
      loader
        .getPrompts()
        .prompts.map((prompt) => prompt.filePath)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(expectedNames.map((name) => join(alias, `${name}.md`)));
    expect(
      loader
        .getThemes()
        .themes.map((theme) => theme.sourcePath)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(expectedNames.map((name) => join(alias, `${name}.json`)));
    expect(loader.getPrompts().diagnostics).toEqual([]);
    expect(loader.getThemes().diagnostics).toEqual([]);

    const relativeRoot = relative(process.cwd(), root);
    await symlink(
      resources,
      join(root, "prompts"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      loadPromptTemplates({
        cwd: root,
        agentDir: relativeRoot,
        promptPaths: [],
        includeDefaults: true,
      })
        .map((prompt) => prompt.filePath)
        .toSorted(),
    ).toEqual(expectedNames.map((name) => join(relativeRoot, "prompts", `${name}.md`)));
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "retains theme directory warnings while unreadable prompts remain best effort",
    async () => {
      const root = tempDirs.make("openclaw-resource-unreadable-");
      const resources = join(root, "resources");
      await mkdir(resources);
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager: SettingsManager.inMemory(),
        additionalPromptTemplatePaths: [resources],
        additionalThemePaths: [resources],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await chmod(resources, 0);
      try {
        await loader.reload();
        expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
        expect(loader.getThemes()).toEqual({
          themes: [],
          diagnostics: [
            { type: "warning", path: resources, message: expect.stringContaining("EACCES") },
          ],
        });
      } finally {
        await chmod(resources, 0o700);
      }
    },
  );

  it("reuses extension modules between loaders and refreshes them on reload", async () => {
    const root = tempDirs.make("openclaw-resource-loader-extension-");
    const extensionPath = join(root, "extension.ts");
    await writeFile(extensionPath, extensionSource("before-reload"));
    const createLoader = () =>
      new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        additionalExtensionPaths: [extensionPath],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

    const firstLoader = createLoader();
    await firstLoader.reload();
    const secondLoader = createLoader();
    await secondLoader.reload();

    expect(extensionCacheTestState()).toEqual({ factoryRuns: 2, moduleLoads: 1 });
    expect(secondLoader.getExtensions().extensions[0]?.commands.has("before-reload")).toBe(true);

    await writeFile(extensionPath, extensionSource("after-reload"));
    await secondLoader.reload();

    expect(extensionCacheTestState()).toEqual({ factoryRuns: 3, moduleLoads: 2 });
    expect(secondLoader.getExtensions().extensions[0]?.commands.has("after-reload")).toBe(true);
  });

  it("does not use unreadable prompt file paths as prompt content", async () => {
    const root = tempDirs.make("openclaw-resource-loader-");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: root,
        appendSystemPrompt: [root],
      });

      await loader.reload();

      expect(loader.getSystemPrompt()).toBeUndefined();
      expect(loader.getAppendSystemPrompt()).toEqual([]);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reports tool and flag conflicts in extension order while retaining the first owner", async () => {
    const root = tempDirs.make("openclaw-resource-loader-conflicts-");
    const factory: ExtensionFactory = (api) => {
      api.registerTool({
        name: "shared",
        label: "Shared",
        description: "Synthetic conflict fixture",
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: undefined }),
      });
      api.registerFlag("shared", { type: "boolean" });
    };
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory(),
      extensionFactories: [factory, factory, factory],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();

    expect(loader.getExtensions().errors).toEqual([
      { path: "<inline:2>", error: 'Tool "shared" conflicts with <inline:1>' },
      { path: "<inline:2>", error: 'Flag "--shared" conflicts with <inline:1>' },
      { path: "<inline:3>", error: 'Tool "shared" conflicts with <inline:1>' },
      { path: "<inline:3>", error: 'Flag "--shared" conflicts with <inline:1>' },
    ]);
    expect(loader.getExtensions().extensions).toHaveLength(3);
  });

  it("inherits Windows source metadata across case-variant resource roots", async () => {
    const root = tempDirs.make("openclaw-resource-loader-scope-");
    const variantAgentDir = join(root, "AGENT");
    const variantPackageDir = join(root, "PACKAGE-SOURCE");
    const defaultSkillDir = join(root, "agent", "skills", "default");
    await mkdir(defaultSkillDir, { recursive: true });

    withMockedWindowsPlatform(() => {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: variantAgentDir,
      });
      const cases = [
        loader["getDefaultSourceInfoForPath"](defaultSkillDir),
        loader["findSourceInfoForPath"](
          join(root, "package-source", "extra", "SKILL.md"),
          new Map([[variantPackageDir, sourceMetadata(variantPackageDir, "extension", "project")]]),
        ),
        loader["findSourceInfoForPath"](
          join(root, "package-source", "package", "SKILL.md"),
          undefined,
          new Map([[variantPackageDir, sourceMetadata(variantPackageDir, "package", "user")]]),
        ),
      ];

      expect(cases).toMatchObject([
        { source: "local", scope: "user", baseDir: join(variantAgentDir, "skills") },
        { source: "extension", scope: "project", baseDir: variantPackageDir },
        { source: "package", scope: "user", baseDir: variantPackageDir },
      ]);
    });
  });
});
