import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { walkDirectorySync } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { expandTildePath } from "../../shared/tilde-path.js";
import type { Skill } from "../../skills/loading/session.js";
import { loadSkills } from "../../skills/loading/session.js";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.js";
import { CONFIG_DIR_NAME } from "../package-metadata.js";
import { canonicalizePath } from "../utils/paths.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { createEventBus, type EventBus } from "./event-bus.js";
import {
  clearExtensionCache,
  createExtensionRuntime,
  loadExtensionFromFactory,
  loadExtensionsCached,
} from "./extensions/loader.js";
import type {
  Extension,
  ExtensionFactory,
  ExtensionRuntime,
  LoadExtensionsResult,
} from "./extensions/types.js";
import type { PromptTemplate } from "./prompt-templates.js";
import { loadPromptTemplates } from "./prompt-templates.js";
import { SettingsManager } from "./settings-manager.js";
import { createSourceInfo, type PathMetadata, type SourceInfo } from "./source-info.js";

export interface ResourceExtensionPaths {
  skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
  promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
  themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoader {
  getExtensions(): LoadExtensionsResult;
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
  getSystemPrompt(): string | undefined;
  getAppendSystemPrompt(): string[];
  extendResources(paths: ResourceExtensionPaths): void;
  reload(): Promise<void>;
}

type ResourceOverride<K extends keyof ResourceLoader> = (
  base: ReturnType<ResourceLoader[K]>,
) => ReturnType<ResourceLoader[K]>;

interface DefaultResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  settingsManager?: SettingsManager;
  extensionFactories?: ExtensionFactory[];
  agentsFilesOverride?: ResourceOverride<"getAgentsFiles">;
  appendSystemPromptTransform?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
  private cwd: string;
  private agentDir: string;
  private settingsManager: SettingsManager;
  private eventBus: EventBus;
  private extensionFactories: ExtensionFactory[];
  private agentsFilesOverride?: ResourceOverride<"getAgentsFiles">;
  private appendSystemPromptTransform?: (base: string[]) => string[];

  private extensionsResult: LoadExtensionsResult;
  private skills: Skill[] = [];
  private skillDiagnostics: ResourceDiagnostic[] = [];
  private prompts: PromptTemplate[] = [];
  private promptDiagnostics: ResourceDiagnostic[] = [];
  private themes: Theme[] = [];
  private themeDiagnostics: ResourceDiagnostic[] = [];
  private agentsFiles: Array<{ path: string; content: string }> = [];
  private appendSystemPrompt: string[] = [];
  private lastSkillPaths: string[] = [];
  private extensionSkillSourceInfos = new Map<string, SourceInfo>();
  private extensionPromptSourceInfos = new Map<string, SourceInfo>();
  private extensionThemeSourceInfos = new Map<string, SourceInfo>();
  private lastPromptPaths: string[] = [];
  private lastThemePaths: string[] = [];
  private loaded = false;

  constructor(options: DefaultResourceLoaderOptions) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir;
    this.settingsManager =
      options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
    this.eventBus = createEventBus();
    this.extensionFactories = options.extensionFactories ?? [];
    this.agentsFilesOverride = options.agentsFilesOverride;
    this.appendSystemPromptTransform = options.appendSystemPromptTransform;

    this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  }

  getExtensions(): LoadExtensionsResult {
    return this.extensionsResult;
  }

  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    return { skills: this.skills, diagnostics: this.skillDiagnostics };
  }

  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
    return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
  }

  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
    return { themes: this.themes, diagnostics: this.themeDiagnostics };
  }

  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
    return { agentsFiles: this.agentsFiles };
  }

  getSystemPrompt(): string | undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
    return this.appendSystemPrompt;
  }

  extendResources(paths: ResourceExtensionPaths): void {
    const skillPaths = this.registerExtensionPaths(
      paths.skillPaths,
      this.extensionSkillSourceInfos,
    );
    const promptPaths = this.registerExtensionPaths(
      paths.promptPaths,
      this.extensionPromptSourceInfos,
    );
    const themePaths = this.registerExtensionPaths(
      paths.themePaths,
      this.extensionThemeSourceInfos,
    );

    if (skillPaths.length > 0) {
      this.lastSkillPaths = this.mergePaths(this.lastSkillPaths, skillPaths);
      this.updateSkillsFromPaths(this.lastSkillPaths);
    }

    if (promptPaths.length > 0) {
      this.lastPromptPaths = this.mergePaths(this.lastPromptPaths, promptPaths);
      this.updatePromptsFromPaths(this.lastPromptPaths);
    }

    if (themePaths.length > 0) {
      this.lastThemePaths = this.mergePaths(this.lastThemePaths, themePaths);
      this.updateThemesFromPaths(this.lastThemePaths);
    }
  }

  async reload(): Promise<void> {
    if (this.loaded) {
      clearExtensionCache();
    }
    await this.settingsManager.reload();
    this.extensionSkillSourceInfos = new Map();
    this.extensionPromptSourceInfos = new Map();
    this.extensionThemeSourceInfos = new Map();

    const extensionsResult = await loadExtensionsCached([], this.cwd, this.eventBus);
    const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
    extensionsResult.extensions.push(...inlineExtensions.extensions);
    extensionsResult.errors.push(...inlineExtensions.errors);

    // Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
    const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
    for (const conflict of conflicts) {
      extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
    }

    this.extensionsResult = extensionsResult;
    this.applyExtensionSourceInfo(this.extensionsResult.extensions);
    this.lastSkillPaths = [];
    this.lastPromptPaths = [];
    this.lastThemePaths = [];
    this.updateSkillsFromPaths([]);
    this.updatePromptsFromPaths([]);
    this.updateThemesFromPaths([]);
    this.agentsFiles = this.agentsFilesOverride?.({ agentsFiles: [] }).agentsFiles ?? [];
    this.appendSystemPrompt = this.appendSystemPromptTransform?.([]) ?? [];
    this.loaded = true;
  }

  private registerExtensionPaths(
    entries: Array<{ path: string; metadata: PathMetadata }> | undefined,
    sourceInfos: Map<string, SourceInfo>,
  ): string[] {
    return (entries ?? []).map((entry) => {
      const path = this.resolveResourcePath(entry.path);
      sourceInfos.set(path, createSourceInfo(path, entry.metadata));
      return path;
    });
  }

  private updateSkillsFromPaths(skillPaths: string[]): void {
    const skillsResult = loadSkills({
      cwd: this.cwd,
      agentDir: this.agentDir,
      skillPaths,
      includeDefaults: false,
    });
    this.skills = skillsResult.skills.map((skill) => ({
      ...skill,
      sourceInfo: this.resolveSourceInfoForPath(
        skill.filePath,
        this.extensionSkillSourceInfos,
        skill.sourceInfo,
      ),
    }));
    this.skillDiagnostics = skillsResult.diagnostics;
  }

  private updatePromptsFromPaths(promptPaths: string[]): void {
    const allPrompts = loadPromptTemplates({
      cwd: this.cwd,
      agentDir: this.agentDir,
      promptPaths,
      includeDefaults: false,
    });
    const { resources, diagnostics } = this.dedupeResources(
      allPrompts,
      "prompt",
      (prompt) => prompt.name,
      (prompt) => prompt.filePath,
    );
    this.prompts = resources.map((prompt) =>
      Object.assign({}, prompt, {
        sourceInfo: this.resolveSourceInfoForPath(
          prompt.filePath,
          this.extensionPromptSourceInfos,
          prompt.sourceInfo,
        ),
      }),
    );
    this.promptDiagnostics = diagnostics;
  }

  private updateThemesFromPaths(themePaths: string[]): void {
    const loaded = this.loadThemes(themePaths);
    const deduped = this.dedupeResources(
      loaded.themes,
      "theme",
      (theme) => theme.name ?? "unnamed",
      (theme) => theme.sourcePath,
    );
    this.themes = deduped.resources.map((theme) => {
      const sourcePath = theme.sourcePath;
      theme.sourceInfo = sourcePath
        ? this.resolveSourceInfoForPath(
            sourcePath,
            this.extensionThemeSourceInfos,
            theme.sourceInfo,
          )
        : theme.sourceInfo;
      return theme;
    });
    this.themeDiagnostics = [...loaded.diagnostics, ...deduped.diagnostics];
  }

  private applyExtensionSourceInfo(extensions: Extension[]): void {
    for (const extension of extensions) {
      extension.sourceInfo = this.resolveSourceInfoForPath(extension.path);
      for (const command of extension.commands.values()) {
        command.sourceInfo = extension.sourceInfo;
      }
      for (const tool of extension.tools.values()) {
        tool.sourceInfo = extension.sourceInfo;
      }
    }
  }

  private resolveSourceInfoForPath(
    resourcePath: string,
    extraSourceInfos?: Map<string, SourceInfo>,
    existing?: SourceInfo,
  ): SourceInfo {
    if (!resourcePath) {
      return existing ?? this.getDefaultSourceInfoForPath(resourcePath);
    }

    if (resourcePath.startsWith("<")) {
      return this.getDefaultSourceInfoForPath(resourcePath);
    }

    const normalizedResourcePath = resolve(resourcePath);
    if (extraSourceInfos) {
      for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
        const normalizedSourcePath = resolve(sourcePath);
        if (isPathInside(normalizedSourcePath, normalizedResourcePath)) {
          return { ...sourceInfo, path: resourcePath };
        }
      }
    }

    return existing ?? this.getDefaultSourceInfoForPath(resourcePath);
  }

  private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
    if (filePath.startsWith("<") && filePath.endsWith(">")) {
      return {
        path: filePath,
        source: filePath.slice(1, -1).split(":")[0] || "temporary",
        scope: "temporary",
        origin: "top-level",
      };
    }

    const normalizedPath = resolve(filePath);
    for (const [baseDir, scope] of [
      [this.agentDir, "user"],
      [join(this.cwd, CONFIG_DIR_NAME), "project"],
    ] as const) {
      for (const resource of ["skills", "prompts", "themes", "extensions"]) {
        const root = join(baseDir, resource);
        if (isPathInside(root, normalizedPath)) {
          return { path: filePath, source: "local", scope, origin: "top-level", baseDir: root };
        }
      }
    }

    return {
      path: filePath,
      source: "local",
      scope: "temporary",
      origin: "top-level",
      baseDir: statSync(normalizedPath).isDirectory()
        ? normalizedPath
        : resolve(normalizedPath, ".."),
    };
  }

  private mergePaths(primary: string[], additional: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();

    for (const p of [...primary, ...additional]) {
      const resolved = this.resolveResourcePath(p);
      const canonicalPath = canonicalizePath(resolved);
      if (seen.has(canonicalPath)) {
        continue;
      }
      seen.add(canonicalPath);
      merged.push(resolved);
    }

    return merged;
  }

  private resolveResourcePath(p: string): string {
    return resolve(this.cwd, expandTildePath(p));
  }

  private loadThemes(paths: string[]): {
    themes: Theme[];
    diagnostics: ResourceDiagnostic[];
  } {
    const themes: Theme[] = [];
    const diagnostics: ResourceDiagnostic[] = [];

    for (const p of paths) {
      const resolved = resolve(this.cwd, p);
      if (!existsSync(resolved)) {
        diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
        continue;
      }

      try {
        const stats = statSync(resolved);
        if (stats.isDirectory()) {
          this.loadThemesFromDir(resolved, themes, diagnostics);
        } else if (stats.isFile() && resolved.endsWith(".json")) {
          this.loadThemeFromFile(resolved, themes, diagnostics);
        } else {
          diagnostics.push({
            type: "warning",
            message: "theme path is not a json file",
            path: resolved,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to read theme path";
        diagnostics.push({ type: "warning", message, path: resolved });
      }
    }

    return { themes, diagnostics };
  }

  private loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
    if (!existsSync(dir)) {
      return;
    }

    try {
      const { entries, failedDirs } = walkDirectorySync(dir, {
        maxDepth: 1,
        symlinks: "follow",
        include: (entry) => entry.kind === "file" && entry.name.endsWith(".json"),
      });
      const failure = failedDirs[0];
      if (failure) {
        throw failure.error;
      }
      for (const entry of entries) {
        this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to read theme directory";
      diagnostics.push({ type: "warning", message, path: dir });
    }
  }

  private loadThemeFromFile(
    filePath: string,
    themes: Theme[],
    diagnostics: ResourceDiagnostic[],
  ): void {
    try {
      themes.push(loadThemeFromPath(filePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to load theme";
      diagnostics.push({ type: "warning", message, path: filePath });
    }
  }

  private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
    extensions: Extension[];
    errors: Array<{ path: string; error: string }>;
  }> {
    const extensions: Extension[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    for (const [index, factory] of this.extensionFactories.entries()) {
      const extensionPath = `<inline:${index + 1}>`;
      try {
        const extension = await loadExtensionFromFactory(
          factory,
          this.cwd,
          this.eventBus,
          runtime,
          extensionPath,
        );
        extensions.push(extension);
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to load extension";
        errors.push({ path: extensionPath, error: message });
      }
    }

    return { extensions, errors };
  }

  private dedupeResources<T>(
    resources: T[],
    resourceType: "prompt" | "theme",
    getName: (resource: T) => string,
    getPath: (resource: T) => string | undefined,
  ): { resources: T[]; diagnostics: ResourceDiagnostic[] } {
    const seen = new Map<string, T>();
    const diagnostics: ResourceDiagnostic[] = [];
    for (const resource of resources) {
      const name = getName(resource);
      const existing = seen.get(name);
      if (existing) {
        const path = getPath(resource);
        diagnostics.push({
          type: "collision",
          message: `name "${resourceType === "prompt" ? "/" : ""}${name}" collision`,
          path,
          collision: {
            resourceType,
            name,
            winnerPath: getPath(existing) ?? "<builtin>",
            loserPath: path ?? "<builtin>",
          },
        });
      } else {
        seen.set(name, resource);
      }
    }
    return { resources: Array.from(seen.values()), diagnostics };
  }

  private detectExtensionConflicts(
    extensions: Extension[],
  ): Array<{ path: string; message: string }> {
    const conflicts: Array<{ path: string; message: string }> = [];

    const owners = { tools: new Map<string, string>(), flags: new Map<string, string>() };
    for (const ext of extensions) {
      for (const kind of ["tools", "flags"] as const) {
        for (const name of ext[kind].keys()) {
          const existingOwner = owners[kind].get(name);
          if (existingOwner && existingOwner !== ext.path) {
            const label = kind === "tools" ? `Tool "${name}"` : `Flag "--${name}"`;
            conflicts.push({ path: ext.path, message: `${label} conflicts with ${existingOwner}` });
          } else {
            owners[kind].set(name, ext.path);
          }
        }
      }
    }

    return conflicts;
  }
}
