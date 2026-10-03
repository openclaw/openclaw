// Package manager tests cover resource discovery boundaries for package,
// project, and npm-declared agent resources.
import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { DefaultPackageManager } from "./package-manager.js";
import { SettingsManager } from "./settings-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type PackageManagerInternals = {
  parseSource(
    source: string,
  ):
    | { type: "npm"; spec: string; name: string; pinned: boolean }
    | { type: "git"; host: string; path: string }
    | { type: "local"; path: string };
  getNpmInstallPath(
    source: { type: "npm"; spec: string; name: string; pinned: boolean },
    scope: "user" | "project" | "temporary",
  ): string;
  getGitInstallPath(
    source: { type: "git"; host: string; path: string },
    scope: "user" | "project" | "temporary",
  ): string;
};

describe("DefaultPackageManager", () => {
  it("keeps manifest resource entries inside the package root", async () => {
    // Manifest globs are package-owned; path traversal or symlink hops must not
    // expose arbitrary host files as skills.
    const root = tempDirs.make("openclaw-package-manager-");
    const packageRoot = join(root, "package");
    const outsideRoot = join(root, "outside");
    const insideSkill = join(packageRoot, "skills", "inside", "SKILL.md");
    const outsideSkill = join(outsideRoot, "SKILL.md");
    await mkdir(join(packageRoot, "skills", "inside"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(insideSkill, "# Inside\n", "utf-8");
    await writeFile(outsideSkill, "# Outside\n", "utf-8");

    const entries = ["skills/inside/SKILL.md", "../outside/SKILL.md", "../outside/*.md"];
    try {
      await symlink(outsideRoot, join(packageRoot, "skills", "linked"), "dir");
      entries.push("skills/linked/SKILL.md");
    } catch {
      // Some filesystems disallow directory symlinks; path traversal coverage is still enough there.
    }

    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ openclaw: { skills: entries } }),
      "utf-8",
    );

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    });

    const resolved = await manager.resolve();
    const skillPaths = resolved.skills.map((skill) => skill.path);

    expect(skillPaths).toContain(insideSkill);
    expect(skillPaths).not.toContain(outsideSkill);
  });

  it("expands manifest resource globs without hidden paths", async () => {
    const root = tempDirs.make("openclaw-package-manager-");
    const packageRoot = join(root, "package");
    const visibleSkill = join(packageRoot, "skills", "visible", "SKILL.md");
    const hiddenSkill = join(packageRoot, "skills", ".hidden", "SKILL.md");
    await mkdir(join(packageRoot, "skills", "visible"), { recursive: true });
    await mkdir(join(packageRoot, "skills", ".hidden"), { recursive: true });
    await writeFile(visibleSkill, "# Visible\n", "utf-8");
    await writeFile(hiddenSkill, "# Hidden\n", "utf-8");
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ openclaw: { skills: ["skills/*"] } }),
      "utf-8",
    );

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    });

    const skillPaths = (await manager.resolve()).skills.map((skill) => skill.path);

    expect(skillPaths).toContain(visibleSkill);
    expect(skillPaths).not.toContain(hiddenSkill);
  });

  it("keeps convention-discovered resource entries inside the package root", async () => {
    const root = tempDirs.make("openclaw-package-manager-");
    const packageRoot = join(root, "package");
    const outsideRoot = join(root, "outside");
    const insideSkill = join(packageRoot, "skills", "inside", "SKILL.md");
    await mkdir(join(packageRoot, "skills", "inside"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(insideSkill, "# Inside\n", "utf-8");
    await writeFile(join(outsideRoot, "SKILL.md"), "# Outside\n", "utf-8");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pkg" }), "utf-8");

    try {
      await symlink(outsideRoot, join(packageRoot, "skills", "linked"), "dir");
    } catch {
      // Some filesystems disallow directory symlinks; skip the symlink-only assertion there.
    }

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    });

    const resolved = await manager.resolve();
    const skillPaths = resolved.skills.map((skill) => skill.path);

    expect(skillPaths).toContain(insideSkill);
    expect(skillPaths.some((skillPath) => skillPath.includes(join("skills", "linked")))).toBe(
      false,
    );
  });

  it("keeps auto-discovered project skills inside their skill root", async () => {
    const root = tempDirs.make("openclaw-package-manager-");
    const agentsSkillsRoot = join(root, ".agents", "skills");
    const insideSkill = join(agentsSkillsRoot, "group", "deep", "t", "SKILL.md");
    const ignoredSkill = join(agentsSkillsRoot, "group", "deep", "i", "SKILL.md");
    const escapedSkill = join(agentsSkillsRoot, "group", "deep", "!x ", "SKILL.md");
    const outsideRoot = join(root, "outside");
    await mkdir(join(root, ".git"));
    await mkdir(join(agentsSkillsRoot, "group", "deep", "t"), { recursive: true });
    await mkdir(join(agentsSkillsRoot, "group", "deep", "i"), { recursive: true });
    await mkdir(join(agentsSkillsRoot, "group", "deep", "!x "), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(insideSkill, "# Inside\n", "utf-8");
    await writeFile(ignoredSkill, "# Ignored\n", "utf-8");
    await writeFile(escapedSkill, "# Ignored\n", "utf-8");
    await writeFile(join(agentsSkillsRoot, "group", ".gitignore"), "i/ \nt/\t\n\\!x\\ \n");
    await writeFile(join(outsideRoot, "SKILL.md"), "# Outside\n", "utf-8");

    try {
      await symlink(outsideRoot, join(agentsSkillsRoot, "linked"), "dir");
    } catch {
      // Some filesystems disallow directory symlinks; the inside assertion still proves discovery.
    }

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({}),
    });

    const resolved = await manager.resolve();
    const skillPaths = resolved.skills.map((skill) => skill.path);

    expect(skillPaths).toContain(insideSkill);
    expect(skillPaths).not.toContain(ignoredSkill);
    expect(skillPaths).not.toContain(escapedSkill);
    expect(skillPaths.some((skillPath) => skillPath.includes(join("skills", "linked")))).toBe(
      false,
    );
  });

  it("loads home-scoped personal skills only for the default state directory", async () => {
    const root = tempDirs.make("openclaw-package-manager-personal-");
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const personalSkill = join(home, ".agents", "skills", "personal", "SKILL.md");
    await mkdir(join(home, ".agents", "skills", "personal"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(personalSkill, "# Personal\n", "utf-8");

    const resolveSkillPaths = async (stateDir: string) =>
      await withEnvAsync(
        { HOME: home, OPENCLAW_HOME: undefined, OPENCLAW_STATE_DIR: stateDir },
        async () => {
          const manager = new DefaultPackageManager({
            cwd: workspace,
            agentDir: join(stateDir, "agents", "main", "agent"),
            settingsManager: SettingsManager.inMemory({}),
          });
          return (await manager.resolve()).skills.map((skill) => skill.path);
        },
      );

    expect(await resolveSkillPaths(join(home, ".openclaw"))).toContain(personalSkill);
    expect(await resolveSkillPaths(join(root, "scratch-state"))).not.toContain(personalSkill);
  });

  it("discovers ancestor skills nearest-first through the repository root", async () => {
    const root = tempDirs.make("openclaw-package-manager-ancestors-");
    const repository = join(root, "repository");
    const cwd = join(repository, "nested");
    const skillPaths = [cwd, repository, root].map((dir) =>
      join(dir, ".agents", "skills", "example", "SKILL.md"),
    );
    for (const skillPath of skillPaths) {
      await mkdir(dirname(skillPath), { recursive: true });
      await writeFile(skillPath, "# Example\n");
    }
    await mkdir(join(repository, ".git"));
    const manager = new DefaultPackageManager({
      cwd,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory(),
    });
    const discovered = async () =>
      (await manager.resolve()).skills
        .map((skill) => skill.path)
        .filter((path) => skillPaths.includes(path));

    expect(await discovered()).toEqual(skillPaths.slice(0, 2));

    await rm(join(repository, ".git"), { recursive: true });
    expect(await discovered()).toEqual(skillPaths);
  });

  it("keeps auto-discovered project resources inside their resource roots", async () => {
    // Project resources may be auto-discovered, but each resource type remains
    // confined to its expected root.
    const root = tempDirs.make("openclaw-package-manager-");
    const configRoot = join(root, ".openclaw");
    const outsideRoot = join(root, "outside");
    const insidePrompt = join(configRoot, "prompts", "inside.md");
    const insideTheme = join(configRoot, "themes", "inside.json");
    const insideExtension = join(configRoot, "extensions", "inside.ts");
    const ignoredPrompt = join(configRoot, "prompts", "ignored.md");
    const ignoredTheme = join(configRoot, "themes", "ignored.json");
    const hiddenPrompt = join(configRoot, "prompts", ".hidden.md");
    const hiddenTheme = join(configRoot, "themes", ".hidden.json");
    const nestedPrompt = join(configRoot, "prompts", "nested", "nested.md");
    const nestedTheme = join(configRoot, "themes", "nested", "nested.json");
    const wrongPromptType = join(configRoot, "prompts", "wrong.json");
    const wrongThemeType = join(configRoot, "themes", "wrong.md");
    await mkdir(join(root, ".git"));
    await mkdir(join(configRoot, "prompts", "nested"), { recursive: true });
    await mkdir(join(configRoot, "themes", "nested"), { recursive: true });
    await mkdir(join(configRoot, "extensions"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(insidePrompt, "# Inside\n", "utf-8");
    await writeFile(insideTheme, "{}\n", "utf-8");
    await writeFile(insideExtension, "export default {};\n", "utf-8");
    await writeFile(ignoredPrompt, "# Ignored\n", "utf-8");
    await writeFile(ignoredTheme, "{}\n", "utf-8");
    await writeFile(nestedPrompt, "# Nested\n", "utf-8");
    await writeFile(nestedTheme, "{}\n", "utf-8");
    await writeFile(hiddenPrompt, "# Hidden\n", "utf-8");
    await writeFile(hiddenTheme, "{}\n", "utf-8");
    await writeFile(wrongPromptType, "{}\n", "utf-8");
    await writeFile(wrongThemeType, "# Wrong\n", "utf-8");
    await writeFile(join(configRoot, "prompts", ".ignore"), "ignored.md\n", "utf-8");
    await writeFile(join(configRoot, "themes", ".ignore"), "ignored.json\n", "utf-8");
    await writeFile(join(outsideRoot, "outside.md"), "# Outside\n", "utf-8");
    await writeFile(join(outsideRoot, "outside.json"), "{}\n", "utf-8");
    await writeFile(join(outsideRoot, "outside.ts"), "export default {};\n", "utf-8");

    try {
      await symlink(join(outsideRoot, "outside.md"), join(configRoot, "prompts", "linked.md"));
      await symlink(join(outsideRoot, "outside.json"), join(configRoot, "themes", "linked.json"));
      await symlink(join(outsideRoot, "outside.ts"), join(configRoot, "extensions", "linked.ts"));
      await symlink(outsideRoot, join(configRoot, "extensions", "linked-dir"), "dir");
    } catch {
      // Some filesystems disallow symlinks; the inside assertions still prove discovery.
    }

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({}),
    });

    const resolved = await manager.resolve();
    const promptPaths = resolved.prompts.map((prompt) => prompt.path);
    const themePaths = resolved.themes.map((theme) => theme.path);

    expect(promptPaths).toContain(insidePrompt);
    expect(themePaths).toContain(insideTheme);
    expect(promptPaths).not.toContain(ignoredPrompt);
    expect(themePaths).not.toContain(ignoredTheme);
    expect(promptPaths).not.toContain(nestedPrompt);
    expect(themePaths).not.toContain(nestedTheme);
    expect(promptPaths).not.toContain(hiddenPrompt);
    expect(themePaths).not.toContain(hiddenTheme);
    expect(promptPaths).not.toContain(wrongPromptType);
    expect(themePaths).not.toContain(wrongThemeType);
    expect(resolved.extensions.map((extension) => extension.path)).toContain(insideExtension);
    expect(promptPaths.some((promptPath) => promptPath.includes("linked"))).toBe(false);
    expect(themePaths.some((themePath) => themePath.includes("linked"))).toBe(false);
    expect(resolved.extensions.some((extension) => extension.path.includes("linked"))).toBe(false);
  });

  it("does not auto-install missing npm package resources", async () => {
    const root = tempDirs.make("openclaw-package-manager-");
    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: ["npm:@openclaw/missing-test"] }),
    });

    const resolved = await manager.resolve();

    expect(resolved.extensions).toEqual([]);
    expect(resolved.skills).toEqual([]);
    expect(resolved.prompts).toEqual([]);
    expect(resolved.themes).toEqual([]);
  });

  it("honors scoped filters on direct local extension files", async () => {
    const root = tempDirs.make("openclaw-package-manager-filter-");
    const extensionPath = join(root, "extension.ts");
    await writeFile(extensionPath, "export default {};\n", "utf-8");
    const settingsManager = SettingsManager.inMemory({
      packages: [{ source: extensionPath, extensions: [] }],
    });
    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager,
    });

    expect((await manager.resolve()).extensions).toEqual([
      expect.objectContaining({ path: extensionPath, enabled: false }),
    ]);

    settingsManager.setProjectPackages([
      { source: extensionPath, extensions: ["*.ts"] },
      { source: extensionPath, extensions: [] },
    ]);
    expect((await manager.resolve()).extensions).toEqual([
      expect.objectContaining({
        path: extensionPath,
        enabled: true,
        metadata: expect.objectContaining({ scope: "project" }),
      }),
    ]);
  });

  it("treats object local directories without filters like string sources", async () => {
    const root = tempDirs.make("openclaw-package-manager-object-");
    const extensionDir = join(root, "extension");
    const extensionPath = join(extensionDir, "index.ts");
    await mkdir(extensionDir);
    await writeFile(extensionPath, "export default {};\n", "utf-8");
    const resolveSource = async (source: string | { source: string; extensions?: string[] }) =>
      await new DefaultPackageManager({
        cwd: root,
        agentDir: join(root, "agent"),
        settingsManager: SettingsManager.inMemory({ packages: [source] }),
      }).resolve();

    expect(await resolveSource({ source: extensionDir })).toEqual(
      await resolveSource(extensionDir),
    );
    expect((await resolveSource({ source: extensionDir, extensions: [] })).extensions).toEqual([
      expect.objectContaining({ path: extensionDir, enabled: false }),
    ]);
  });

  it("preserves manifest omission, convention fallback, and force-include ordering", async () => {
    const root = tempDirs.make("openclaw-package-manager-manifest-");
    const packageRoot = join(root, "package");
    for (const dir of ["prompts", "custom"]) {
      await mkdir(join(packageRoot, dir), { recursive: true });
      for (const name of ["a", "b"]) {
        await writeFile(join(packageRoot, dir, `${name}.md`), name);
      }
    }
    const orderedManifest = {
      prompts: ["custom/a.md", "custom/b.md", "!custom/a.md", "+custom/a.md"],
    };
    const cases: Array<{
      name: string;
      manifest?: { prompts?: string[] };
      filter?: { prompts?: string[]; skills?: string[] };
      expected: Array<[string, boolean]>;
    }> = [
      {
        name: "no manifest",
        expected: [
          ["prompts/a.md", true],
          ["prompts/b.md", true],
        ],
      },
      { name: "omitted manifest type", manifest: {}, expected: [] },
      { name: "empty manifest type", manifest: { prompts: [] }, expected: [] },
      {
        name: "another type filtered",
        manifest: {},
        filter: { skills: [] },
        expected: [
          ["prompts/a.md", true],
          ["prompts/b.md", true],
        ],
      },
      {
        name: "empty entries with user filter",
        manifest: { prompts: [] },
        filter: { prompts: ["*.md"] },
        expected: [
          ["prompts/a.md", true],
          ["prompts/b.md", true],
        ],
      },
      {
        name: "empty user filter",
        manifest: {},
        filter: { prompts: [] },
        expected: [
          ["prompts/a.md", false],
          ["prompts/b.md", false],
        ],
      },
      {
        name: "unfiltered force-include order",
        manifest: orderedManifest,
        expected: [
          ["custom/a.md", true],
          ["custom/b.md", true],
        ],
      },
      {
        name: "filtered force-include order",
        manifest: orderedManifest,
        filter: { prompts: ["*.md", "!b.md"] },
        expected: [
          ["custom/b.md", false],
          ["custom/a.md", true],
        ],
      },
    ];
    for (const { name, manifest, filter, expected } of cases) {
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ openclaw: manifest }));
      const manager = new DefaultPackageManager({
        cwd: root,
        agentDir: join(root, "agent"),
        settingsManager: SettingsManager.inMemory({
          packages: [{ source: packageRoot, ...filter }],
        }),
      });
      expect(
        (await manager.resolve()).prompts.map(({ path, enabled }) => [path, enabled]),
        name,
      ).toEqual(expected.map(([path, enabled]) => [join(packageRoot, path), enabled]));
    }
  });

  it.each([
    ["local", "./missing-extension.ts"],
    ["npm", "npm:@openclaw/missing-test"],
    ["git", "https://github.com/openclaw/missing-test.git"],
  ])("reports missing %s package sources through the owner callback", async (_kind, source) => {
    const root = tempDirs.make("openclaw-package-manager-missing-");
    const onMissing = vi.fn(async () => "skip" as const);
    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [source] }),
    });

    const resolved = await manager.resolve(onMissing);

    expect(onMissing).toHaveBeenCalledOnce();
    expect(onMissing).toHaveBeenCalledWith(source);
    expect(resolved).toEqual({ extensions: [], skills: [], prompts: [], themes: [] });
  });

  it("keeps temporary package paths in a private per-agent directory", async () => {
    const root = tempDirs.make("openclaw-package-manager-temp-");
    const agentDir = join(root, "agent");
    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
    }) as unknown as PackageManagerInternals;
    const npmSource = manager.parseSource("npm:@openclaw/example");
    const gitSource = manager.parseSource("https://github.com/openclaw/example.git");
    if (npmSource.type !== "npm" || gitSource.type !== "git") {
      throw new Error("Expected package sources");
    }

    const npmPath = manager.getNpmInstallPath(npmSource, "temporary");
    const gitPath = manager.getGitInstallPath(gitSource, "temporary");
    const tempRoot = join(agentDir, "tmp", "resources");

    expect(relative(tempRoot, npmPath).startsWith("..")).toBe(false);
    expect(relative(tempRoot, gitPath).startsWith("..")).toBe(false);
    if (process.platform !== "win32") {
      expect((await stat(tempRoot)).mode & 0o777).toBe(0o700);
    }
  });
});
