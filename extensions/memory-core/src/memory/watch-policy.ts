import fs from "node:fs/promises";
import path from "node:path";
import {
  admitObservationRoot,
  isPathInside,
  observationPrefixKind,
  type ObservationRoot,
  type WatchEntry,
  type WatchScope,
} from "openclaw/plugin-sdk/file-access-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  matchesExtraMemoryPathEntry,
  normalizeExtraMemoryPathEntries,
  type MemoryWorkspaceWatchRequest,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemoryWatchFile } from "./watch-settle.js";

type Settings = MemoryWorkspaceWatchRequest["settings"];
type Target = { path: string; kind: WatchScope["kind"]; core: boolean };
type Selection = {
  scope: WatchScope;
  resolved: string;
  lexical: string;
  core: boolean;
  alias: boolean;
};
export type MemoryObservation = { root: ObservationRoot; selections: Selection[] };
const IGNORED = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

// Lists only the configured path's prefixes, never a second recursive watcher.
// The first symbolic entry must be observed instead of a scope through that link.
async function firstLink(
  authority: ObservationRoot,
  relative: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  let parent = ".";
  const segments = relative.split(path.sep).filter((part) => part && part !== ".");
  for (const segment of segments) {
    signal.throwIfAborted();
    parent = path.join(parent, segment);
    const kind = await observationPrefixKind(authority, parent, signal);
    if (kind === "symlink") {
      return parent;
    }
    if (kind !== "directory") {
      return undefined;
    }
  }
  return undefined;
}

export class MemoryWatchPolicy {
  private readonly roots = new Map<string, ObservationRoot>();
  private readonly targets: Target[];
  private readonly extras: ReturnType<typeof normalizeExtraMemoryPathEntries>;

  constructor(
    workspace: string,
    private readonly settings: Settings,
  ) {
    this.extras = normalizeExtraMemoryPathEntries(workspace, settings.extraPaths);
    this.targets = [
      { path: path.resolve(workspace, "MEMORY.md"), kind: "entry", core: true },
      { path: path.resolve(workspace, "USER.md"), kind: "entry", core: true },
      { path: path.resolve(workspace, "memory"), kind: "tree", core: true },
      // A tree scope also selects an extra path that is a regular file. Missing
      // configured roots stay observed and do not require a Gateway restart.
      ...this.extras.map((entry) => ({ path: entry.path, kind: "tree" as const, core: false })),
    ];
  }

  private async admit(boundary: string, signal: AbortSignal): Promise<ObservationRoot> {
    const cached = this.roots.get(boundary);
    if (cached) {
      return cached;
    }
    const admitted = await admitObservationRoot(boundary, "allow");
    signal.throwIfAborted();
    this.roots.set(boundary, admitted);
    return admitted;
  }

  async observations(signal: AbortSignal): Promise<MemoryObservation[]> {
    const groups = new Map<ObservationRoot, MemoryObservation>();
    const add = (authority: ObservationRoot, selection: Selection) => {
      const group = groups.get(authority) ?? { root: authority, selections: [] };
      group.selections.push(selection);
      groups.set(authority, group);
    };
    for (const target of this.targets) {
      signal.throwIfAborted();
      // Keep a stable parent so replacing the workspace/extra root is observable.
      let boundary = target.core
        ? path.dirname(path.dirname(target.path))
        : path.dirname(target.path);
      let absolute = target.path;
      for (let links = 0; ; links++) {
        if (links >= 40) {
          throw new Error("Memory watch target has too many symbolic links");
        }
        const authority = await this.admit(boundary, signal);
        signal.throwIfAborted();
        const relative = path.relative(authority.rootDir, absolute) || ".";
        const link = await firstLink(authority, relative, signal);
        signal.throwIfAborted();
        add(authority, {
          scope: link
            ? { path: link, kind: "entry" }
            : { path: relative, kind: target.kind, depth: 128 },
          resolved: path.resolve(authority.rootDir, link ?? relative),
          lexical: target.path,
          core: target.core,
          alias: link !== undefined,
        });
        // The indexer rejects root-entry links. Only configured parent aliases
        // grant access to a target; retain the link itself to detect replacement.
        if (!link || path.normalize(link) === path.normalize(relative)) {
          break;
        }
        const alias = path.resolve(authority.rootDir, link);
        const destination = await fs.readlink(alias);
        signal.throwIfAborted();
        absolute = path.resolve(path.dirname(alias), destination, path.relative(alias, absolute));
        boundary = path.dirname(absolute);
      }
    }
    return [...groups.values()];
  }

  scopes(group: MemoryObservation): WatchScope[] {
    return [
      ...new Map(group.selections.map(({ scope }) => [JSON.stringify(scope), scope])).values(),
    ];
  }

  private ignored(relative: string, file: string, kind: WatchEntry["kind"]): boolean {
    if (relative.split(path.sep).some((part) => IGNORED.has(part.toLowerCase()))) {
      return true;
    }
    if (kind === "directory") {
      return false;
    }
    if (kind === "symlink") {
      return true;
    }
    const extension = path.extname(file).toLowerCase();
    return (
      extension !== "" &&
      extension !== ".md" &&
      classifyMemoryMultimodalPath(file, this.settings.multimodal) === null
    );
  }

  exclude(group: MemoryObservation, entry: WatchEntry): boolean {
    const absolute = path.resolve(group.root.rootDir, entry.path);
    for (const selection of group.selections) {
      const selected = selection.resolved;
      if (
        absolute === selected ||
        (selection.scope.kind === "tree" && isPathInside(selected, absolute))
      ) {
        if (selection.alias && absolute === selected) {
          return false;
        }
        const relative = path.relative(selected, absolute);
        const lexical = path.join(selection.lexical, relative);
        if (!this.ignored(relative, lexical, entry.kind)) {
          return false;
        }
      } else if (isPathInside(absolute, selected)) {
        // Prefix directories are observation plumbing, not Memory content.
        return false;
      }
    }
    return true;
  }

  select(
    group: MemoryObservation,
    relative: string,
    structural: boolean,
  ): MemoryWatchFile | undefined {
    const absolute = path.resolve(group.root.rootDir, relative);
    for (const selection of group.selections) {
      const selected = selection.resolved;
      if (
        absolute !== selected &&
        (selection.scope.kind !== "tree" || !isPathInside(selected, absolute))
      ) {
        continue;
      }
      if (selection.alias) {
        return { root: group.root, relative: selection.scope.path, sample: false };
      }
      const selectedRelative = path.relative(selected, absolute);
      const lexical = path.join(selection.lexical, selectedRelative);
      if (this.ignored(selectedRelative, lexical, structural ? "directory" : "file")) {
        continue;
      }
      if (
        !selection.core &&
        !this.extras.some(
          (entry) =>
            isPathInside(entry.path, lexical) &&
            ((!this.ignored(selectedRelative, lexical, "file") &&
              matchesExtraMemoryPathEntry(entry, lexical)) ||
              (structural && matchesExtraMemoryPathEntry(entry, lexical, { directory: true }))),
        )
      ) {
        continue;
      }
      return { root: group.root, relative, sample: true };
    }
    return undefined;
  }
}
