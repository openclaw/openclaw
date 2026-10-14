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
import { createExtensionRuntime, loadExtensionFromFactory } from "./extensions/loader.js";
import type { Extension, ExtensionFactory, LoadExtensionsResult } from "./extensions/types.js";
import type { PromptTemplate } from "./prompt-templates.js";
import { loadPromptTemplates } from "./prompt-templates.js";
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
  extendResources(paths: ResourceExtensionPaths): void;
  reload(): Promise<void>;
}

interface DefaultResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  extensionFactories?: ExtensionFactory[];
}

class ResourceCollection<T> {
  resources: T[] = [];
  diagnostics: ResourceDiagnostic[] = [];
  paths: string[] = [];
  sourceInfos = new Map<string, SourceInfo>();

  constructor(
    private load: (paths: string[]) => { resources: T[]; diagnostics: ResourceDiagnostic[] },
    private decorate: (resource: T, sourceInfos: Map<string, SourceInfo>) => T,
  ) {}

  register(
    entries: ResourceExtensionPaths["skillPaths"],
    resolvePath: (path: string) => string,
  ): string[] {
    const sourceInfos = this.sourceInfos;
    return (entries ?? []).map((entry) => {
      const path = resolvePath(entry.path);
      sourceInfos.set(path, createSourceInfo(path, entry.metadata));
      return path;
    });
  }

  update(paths: string[]): void {
    const loaded = this.load(paths);
    this.resources = loaded.resources.map((resource) => this.decorate(resource, this.sourceInfos));
    this.diagnostics = loaded.diagnostics;
  }
}

export class DefaultResourceLoader implements ResourceLoader {
  private cwd: string;
  private agentDir: string;
  private eventBus: EventBus;
  private extensionFactories: ExtensionFactory[];

  private extensionsResult: LoadExtensionsResult;
  private skillResources = new ResourceCollection<Skill>(
    (skillPaths) => {
      const { skills, diagnostics } = loadSkills({
        cwd: this.cwd,
        agentDir: this.agentDir,
        skillPaths,
        includeDefaults: false,
      });
      return { resources: skills, diagnostics };
    },
    (skill, sources) => ({
      ...skill,
      sourceInfo: this.resolveSourceInfoForPath(skill.filePath, sources, skill.sourceInfo),
    }),
  );
  private promptResources = new ResourceCollection<PromptTemplate>(
    (promptPaths) =>
      this.dedupeResources(
        loadPromptTemplates({ cwd: this.cwd, agentDir: this.agentDir, promptPaths }),
        "prompt",
        (prompt) => prompt.name,
        (prompt) => prompt.filePath,
      ),
    (prompt, sources) =>
      Object.assign({}, prompt, {
        sourceInfo: this.resolveSourceInfoForPath(prompt.filePath, sources, prompt.sourceInfo),
      }),
  );
  private themeResources = new ResourceCollection<Theme>(
    (themePaths) => {
      const loaded = this.loadThemes(themePaths);
      const deduped = this.dedupeResources(
        loaded.themes,
        "theme",
        (theme) => theme.name ?? "unnamed",
        (theme) => theme.sourcePath,
      );
      return {
        resources: deduped.resources,
        diagnostics: [...loaded.diagnostics, ...deduped.diagnostics],
      };
    },
    (theme, sources) => {
      const sourcePath = theme.sourcePath;
      theme.sourceInfo = sourcePath
        ? this.resolveSourceInfoForPath(sourcePath, sources, theme.sourceInfo)
        : theme.sourceInfo;
      return theme;
    },
  );

  constructor(options: DefaultResourceLoaderOptions) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir;
    this.eventBus = createEventBus();
    this.extensionFactories = options.extensionFactories ?? [];

    this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  }

  getExtensions(): LoadExtensionsResult {
    return this.extensionsResult;
  }

  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    return { skills: this.skillResources.resources, diagnostics: this.skillResources.diagnostics };
  }

  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
    return {
      prompts: this.promptResources.resources,
      diagnostics: this.promptResources.diagnostics,
    };
  }

  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
    return { themes: this.themeResources.resources, diagnostics: this.themeResources.diagnostics };
  }

  extendResources(paths: ResourceExtensionPaths): void {
    const resolvePath = (path: string) => this.resolveResourcePath(path);
    const registered = [
      [this.skillResources, this.skillResources.register(paths.skillPaths, resolvePath)],
      [this.promptResources, this.promptResources.register(paths.promptPaths, resolvePath)],
      [this.themeResources, this.themeResources.register(paths.themePaths, resolvePath)],
    ] as const;
    for (const [collection, additional] of registered) {
      if (additional.length > 0) {
        collection.paths = this.mergePaths(collection.paths, additional);
        collection.update(collection.paths);
      }
    }
  }

  async reload(): Promise<void> {
    for (const collection of [this.skillResources, this.promptResources, this.themeResources]) {
      collection.sourceInfos = new Map();
    }

    const extensionsResult: LoadExtensionsResult = {
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    };
    for (const [index, factory] of this.extensionFactories.entries()) {
      const extensionPath = `<inline:${index + 1}>`;
      try {
        extensionsResult.extensions.push(
          await loadExtensionFromFactory(
            factory,
            this.cwd,
            this.eventBus,
            extensionsResult.runtime,
            extensionPath,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to load extension";
        extensionsResult.errors.push({ path: extensionPath, error: message });
      }
    }

    // Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
    const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
    for (const conflict of conflicts) {
      extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
    }

    this.extensionsResult = extensionsResult;
    for (const collection of [this.skillResources, this.promptResources, this.themeResources]) {
      collection.paths = [];
    }
    this.skillResources.update([]);
    this.promptResources.update([]);
    this.themeResources.update([]);
  }

  private resolveSourceInfoForPath(
    resourcePath: string,
    extraSourceInfos: Map<string, SourceInfo>,
    existing?: SourceInfo,
  ): SourceInfo {
    const normalizedResourcePath = resolve(resourcePath);
    for (const [sourcePath, sourceInfo] of extraSourceInfos) {
      if (isPathInside(sourcePath, normalizedResourcePath)) {
        return { ...sourceInfo, path: resourcePath };
      }
    }

    return existing ?? this.getDefaultSourceInfoForPath(resourcePath);
  }

  private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
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

      let failureMessage = "failed to read theme path";
      try {
        const stats = statSync(resolved);
        let filePaths: string[];
        if (stats.isDirectory()) {
          if (!existsSync(resolved)) {
            continue;
          }
          failureMessage = "failed to read theme directory";
          const { entries, failedDirs } = walkDirectorySync(resolved, {
            maxDepth: 1,
            symlinks: "follow",
            include: (entry) => entry.kind === "file" && entry.name.endsWith(".json"),
          });
          const failure = failedDirs[0];
          if (failure) {
            throw failure.error;
          }
          filePaths = entries.map((entry) => join(resolved, entry.name));
        } else if (stats.isFile() && resolved.endsWith(".json")) {
          filePaths = [resolved];
        } else {
          diagnostics.push({
            type: "warning",
            message: "theme path is not a json file",
            path: resolved,
          });
          continue;
        }
        for (const filePath of filePaths) {
          try {
            themes.push(loadThemeFromPath(filePath));
          } catch (error) {
            const message = error instanceof Error ? error.message : "failed to load theme";
            diagnostics.push({ type: "warning", message, path: filePath });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : failureMessage;
        diagnostics.push({ type: "warning", message, path: resolved });
      }
    }

    return { themes, diagnostics };
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
