import fs from "node:fs/promises";
import path from "node:path";
import { canonicalPathFromExistingAncestor } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root, type Root } from "@openclaw/fs-safe/root";
import type { WatchEntry, WatchScope } from "@openclaw/fs-safe/watch";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  matchesExtraMemoryPathEntry,
  normalizeExtraMemoryPathEntries,
  type MemoryWorkspaceWatchRequest,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemoryWatchFile } from "./watch-settle.js";

type Settings = MemoryWorkspaceWatchRequest["settings"];
type Target = { path: string; kind: WatchScope["kind"]; core: boolean };
type Selection = { scope: WatchScope; lexical: string; core: boolean; alias?: true };
export type MemoryObservation = { root: Root; selections: Selection[] };
const IGNORED = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "not-found")
  );
}

/** Initial admission only. Later retries retain every successfully pinned Root. */
async function observationAncestor(boundary: string, signal: AbortSignal): Promise<string> {
  const absolute = path.resolve(boundary);
  let existing = path.parse(absolute).root;
  for (const segment of path.relative(existing, absolute).split(path.sep).filter(Boolean)) {
    signal.throwIfAborted();
    const candidate = path.join(existing, segment);
    try {
      const info = await fs.lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return existing;
      }
      existing = candidate;
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
      return existing;
    }
  }
  return existing;
}

// Lists only the configured path's prefixes, never a second recursive watcher.
// The first symbolic entry must be observed instead of a scope through that link.
async function firstLink(
  authority: Root,
  relative: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  let parent = ".";
  const segments = relative.split(path.sep).filter((part) => part && part !== ".");
  for (const segment of segments) {
    signal.throwIfAborted();
    parent = path.join(parent, segment);
    // Guarded lookup owns case/short-name semantics; exact directory-name
    // comparison would miss aliases on Windows and case-insensitive macOS.
    const entries = authority.entries("./" + parent, { symlinks: "reject", maxEntries: 1, signal });
    try {
      await entries.next();
    } catch (error) {
      if (error instanceof FsSafeError) {
        if (error.code === "symlink") {
          return parent;
        }
        if (error.code === "not-file" || error.code === "not-found") {
          return undefined;
        }
      }
      throw error;
    } finally {
      await entries.return?.();
    }
  }
  return undefined;
}

export class MemoryWatchPolicy {
  private readonly roots = new Map<string, Promise<Root>>();
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

  private admit(boundary: string, signal: AbortSignal): Promise<Root> {
    let pending = this.roots.get(boundary);
    if (!pending) {
      pending = observationAncestor(boundary, signal).then((ancestor) => {
        signal.throwIfAborted();
        return root(ancestor, { symlinks: "reject", hardlinks: "allow" });
      });
      this.roots.set(boundary, pending);
      const attempted = pending;
      void pending.catch(() => {
        if (this.roots.get(boundary) === attempted) {
          this.roots.delete(boundary);
        }
      });
    }
    return pending;
  }

  async observations(signal: AbortSignal): Promise<MemoryObservation[]> {
    const groups = new Map<Root, MemoryObservation>();
    const add = (authority: Root, selection: Selection) => {
      const group = groups.get(authority) ?? { root: authority, selections: [] };
      group.selections.push(selection);
      groups.set(authority, group);
    };
    for (const target of this.targets) {
      signal.throwIfAborted();
      // Keep a stable parent so replacing the workspace/extra root is observable.
      const boundary = target.core
        ? path.dirname(path.dirname(target.path))
        : path.dirname(target.path);
      const authority = await this.admit(boundary, signal);
      signal.throwIfAborted();
      const relative = path.relative(authority.rootDir, target.path) || ".";
      const link = await firstLink(authority, relative, signal);
      signal.throwIfAborted();
      if (!link) {
        add(authority, {
          scope: { path: relative, kind: target.kind, depth: 128 },
          lexical: target.path,
          core: target.core,
        });
        continue;
      }
      add(authority, {
        scope: { path: link, kind: "entry" },
        lexical: target.path,
        core: target.core,
        alias: true,
      });
      // Core paths follow their root alias. Extra paths may have an explicitly
      // configured aliased parent (including /tmp on macOS), but never follow
      // the extra root entry itself or symbolic children.
      if (!target.core && path.normalize(link) === path.normalize(relative)) {
        continue;
      }
      let canonical: string;
      try {
        canonical = target.core
          ? await canonicalPathFromExistingAncestor(target.path)
          : path.join(
              await canonicalPathFromExistingAncestor(path.dirname(target.path)),
              path.basename(target.path),
            );
      } catch (error) {
        if (missing(error)) {
          continue;
        }
        throw error;
      }
      signal.throwIfAborted();
      for (let links = 0; ; links++) {
        signal.throwIfAborted();
        if (links >= 40) {
          throw new Error("Memory watch target has too many symbolic links");
        }
        const admitted = await this.admit(path.dirname(canonical), signal);
        signal.throwIfAborted();
        const canonicalRelative = path.relative(admitted.rootDir, canonical) || ".";
        const remainingLink = await firstLink(admitted, canonicalRelative, signal);
        if (!remainingLink) {
          add(admitted, {
            scope: { path: canonicalRelative, kind: target.kind, depth: 128 },
            lexical: target.path,
            core: target.core,
          });
          break;
        }
        add(admitted, {
          scope: { path: remainingLink, kind: "entry" },
          lexical: target.path,
          core: target.core,
          alias: true,
        });
        if (!target.core) {
          break;
        }
        // realpath cannot resolve a dangling link. Core roots explicitly trust
        // their targets, including absent descendants: observe each lexical
        // link and admit the selected target's stable ancestor separately. This
        // reads only an admitted link name, never event-supplied file content.
        const alias = path.resolve(admitted.rootDir, remainingLink);
        const destination = await fs.readlink(alias);
        signal.throwIfAborted();
        canonical = await canonicalPathFromExistingAncestor(
          path.resolve(path.dirname(alias), destination, path.relative(alias, canonical)),
        );
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
      const selected = path.resolve(group.root.rootDir, selection.scope.path);
      if (
        absolute === selected ||
        (selection.scope.kind === "tree" && isPathInside(selected, absolute))
      ) {
        if (selection.alias && absolute === selected) {
          return false;
        }
        const lexical = path.join(selection.lexical, path.relative(selected, absolute));
        if (!this.ignored(path.relative(selected, absolute), lexical, entry.kind)) {
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
    if (path.isAbsolute(relative)) {
      return undefined;
    }
    const absolute = path.resolve(group.root.rootDir, relative);
    if (!isPathInside(group.root.rootDir, absolute)) {
      return undefined;
    }
    for (const selection of group.selections) {
      const selected = path.resolve(group.root.rootDir, selection.scope.path);
      if (
        absolute !== selected &&
        (selection.scope.kind !== "tree" || !isPathInside(selected, absolute))
      ) {
        continue;
      }
      if (selection.alias) {
        return { root: group.root, relative: selection.scope.path, sample: false };
      }
      const lexical = path.join(selection.lexical, path.relative(selected, absolute));
      if (
        this.ignored(path.relative(selected, absolute), lexical, structural ? "directory" : "file")
      ) {
        continue;
      }
      if (
        !structural &&
        !selection.core &&
        !this.extras.some((entry) => matchesExtraMemoryPathEntry(entry, lexical))
      ) {
        continue;
      }
      return { root: group.root, relative, sample: true };
    }
    return undefined;
  }
}
