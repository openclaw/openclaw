// Prepared resource loader tests cover extension resources and diagnostics.
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withMockedWindowsPlatform } from "../../test-utils/vitest-spies.js";
import darkTheme from "../modes/interactive/theme/dark.json" with { type: "json" };
import type { ExtensionFactory } from "./extensions/types.js";
import { loadPromptTemplates } from "./prompt-templates.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import type { SourceScope } from "./source-info.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sourceMetadata(path: string, source: string, scope: SourceScope) {
  return { path, source, scope, origin: "package" as const, baseDir: path };
}

function createLoader(
  root: string,
  options: Partial<ConstructorParameters<typeof DefaultResourceLoader>[0]> = {},
) {
  return new DefaultResourceLoader({ cwd: root, agentDir: root, ...options });
}

describe("DefaultResourceLoader", () => {
  it("loads explicit prompts and themes without ambient resolution, retaining the first collision owner", async () => {
    const root = tempDirs.make("openclaw-resource-collisions-");
    const paths: [string, string] = [join(root, "first"), join(root, "second")];
    for (const path of paths) {
      await mkdir(path);
      await writeFile(join(path, "shared.md"), `Prompt from ${path}`);
      await writeFile(join(path, "shared.json"), JSON.stringify({ ...darkTheme, name: "shared" }));
    }
    const loader = createLoader(root);

    await loader.reload();
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    loader.extendResources({
      promptPaths: paths.map((path) => ({
        path,
        metadata: sourceMetadata(path, "extension", "temporary"),
      })),
      themePaths: paths.map((path) => ({
        path,
        metadata: sourceMetadata(path, "extension", "temporary"),
      })),
    });

    expect(loader.getPrompts().prompts).toEqual([
      expect.objectContaining({ name: "shared", filePath: join(paths[0], "shared.md") }),
    ]);
    expect(loader.getThemes().themes.map((theme) => theme.sourcePath)).toEqual([
      join(paths[0], "shared.json"),
    ]);
    for (const [resourceType, extension, diagnostics, name] of [
      ["prompt", "md", loader.getPrompts().diagnostics, "/shared"],
      ["theme", "json", loader.getThemes().diagnostics, "shared"],
    ] as const) {
      const winnerPath = join(paths[0], `shared.${extension}`);
      const loserPath = join(paths[1], `shared.${extension}`);
      expect(diagnostics).toEqual([
        {
          type: "collision",
          message: `name "${name}" collision`,
          path: loserPath,
          collision: { resourceType, name: "shared", winnerPath, loserPath },
        },
      ]);
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
    const loader = createLoader(root, {});

    await loader.reload();
    const entry = { path: alias, metadata: sourceMetadata(alias, "extension", "temporary") };
    loader.extendResources({ promptPaths: [entry], themePaths: [entry] });

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
      const loader = createLoader(root, {});
      await chmod(resources, 0);
      try {
        await loader.reload();
        const entry = {
          path: resources,
          metadata: sourceMetadata(resources, "extension", "temporary"),
        };
        loader.extendResources({ promptPaths: [entry], themePaths: [entry] });
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

  it("reports tool and flag conflicts in extension order while retaining the first owner", async () => {
    const root = tempDirs.make("openclaw-resource-loader-conflicts-");
    let description = "Initial registration";
    const factory: ExtensionFactory = (api) => {
      api.registerTool({
        name: "shared",
        label: "Shared",
        description,
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: undefined }),
      });
      api.registerFlag("shared", { type: "boolean" });
      api.registerCommand("shared", { handler: async () => {} });
    };
    const loader = createLoader(root, {
      extensionFactories: [factory, factory, factory],
    });

    await loader.reload();

    expect(loader.getExtensions().errors).toEqual([
      { path: "<inline:2>", error: 'Tool "shared" conflicts with <inline:1>' },
      { path: "<inline:2>", error: 'Flag "--shared" conflicts with <inline:1>' },
      { path: "<inline:3>", error: 'Tool "shared" conflicts with <inline:1>' },
      { path: "<inline:3>", error: 'Flag "--shared" conflicts with <inline:1>' },
    ]);
    expect(loader.getExtensions().extensions).toHaveLength(3);

    description = "Reloaded registration";
    await loader.reload();
    expect(loader.getExtensions().extensions).toHaveLength(3);
    for (const [index, extension] of loader.getExtensions().extensions.entries()) {
      const sourceInfo = {
        path: `<inline:${index + 1}>`,
        source: "inline",
        scope: "temporary",
        origin: "top-level",
      };
      expect(extension.sourceInfo).toMatchObject(sourceInfo);
      expect(extension.tools.get("shared")).toMatchObject({
        definition: { description: "Reloaded registration" },
        sourceInfo,
      });
      expect(extension.commands.get("shared")).toMatchObject({ sourceInfo });
    }
  });

  it("inherits Windows source metadata across case-variant resource roots", async () => {
    const root = tempDirs.make("openclaw-resource-loader-scope-");
    const variantAgentDir = join(root, "AGENT");
    const variantPackageDir = join(root, "PACKAGE-SOURCE");
    const defaultThemeDir = join(root, "agent", "themes");
    const packageDir = join(root, "package-source");
    for (const directory of [defaultThemeDir, packageDir, variantPackageDir]) {
      await mkdir(directory, { recursive: true });
    }
    const themePaths = [
      join(defaultThemeDir, "default.json"),
      join(packageDir, "package.json"),
      join(packageDir, "extra.json"),
    ];
    for (const [index, name] of ["default", "package", "extra"].entries()) {
      await writeFile(themePaths[index]!, JSON.stringify({ ...darkTheme, name }));
    }
    await withMockedWindowsPlatform(async () => {
      const loader = createLoader(root, {
        agentDir: variantAgentDir,
      });
      await loader.reload();
      loader.extendResources({
        themePaths: [
          {
            path: themePaths[0]!,
            metadata: {
              source: "local",
              scope: "user",
              origin: "top-level",
              baseDir: join(variantAgentDir, "themes"),
            },
          },
          {
            path: variantPackageDir,
            metadata: sourceMetadata(variantPackageDir, "package", "user"),
          },
          ...themePaths
            .slice(1)
            .map((path) => ({ path, metadata: sourceMetadata(path, "fallback", "temporary") })),
        ],
      });
      const sourceInfo = (name: string) =>
        loader.getThemes().themes.find((theme) => theme.name === name)?.sourceInfo;

      expect(sourceInfo("default")).toMatchObject({
        source: "local",
        scope: "user",
        baseDir: join(variantAgentDir, "themes"),
      });
      expect(sourceInfo("package")).toMatchObject({
        source: "package",
        scope: "user",
        baseDir: variantPackageDir,
      });
      loader.extendResources({
        themePaths: [
          {
            path: variantPackageDir,
            metadata: sourceMetadata(variantPackageDir, "extension", "project"),
          },
        ],
      });
      expect(sourceInfo("extra")).toMatchObject({
        source: "extension",
        scope: "project",
        baseDir: variantPackageDir,
      });
    });
  });
});
