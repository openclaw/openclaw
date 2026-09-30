import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root, type Root } from "@openclaw/fs-safe/root";
import type { WatchEntry, WatchScope } from "@openclaw/fs-safe/watch";
import { admitObservationRoot, observationPrefixKind } from "../src/infra/fs-observation-root.ts";
import { runNodeConfigFiles } from "./run-node-watch-paths.mts";
import type { WatchOptions } from "./watch-node-observation.mts";

// Bound source discovery independently of backend transport resources.
const SOURCE_OBSERVATION_LIMITS = {
  mappings: 128,
  entries: 100_000,
  directories: 4096,
  depth: 128,
  linkHops: 32,
} as const;

type Mapping = { physical: string; lexical: string; kind: "entry" | "tree" };
export type SourceTargetGroup = { authority: Root; mappings: Mapping[]; scopes: WatchScope[] };

function relativeInside(parent: string, child: string): string | undefined {
  const relative = path.relative(parent, child);
  return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
    ? undefined
    : relative;
}

/** Name mapping only. Notifications never become discovery/read inputs. */
export function sourceTargetPaths(group: SourceTargetGroup, relative: string): string[] {
  const physical = path.resolve(group.authority.rootReal, relative);
  const selected = new Set<string>();
  for (const mapping of group.mappings) {
    const suffix = relativeInside(mapping.physical, physical);
    if (suffix !== undefined && (!suffix || mapping.kind === "tree")) {
      selected.add(path.resolve(mapping.lexical, suffix));
    } else if (relativeInside(physical, mapping.physical) !== undefined) {
      selected.add(mapping.lexical);
    }
  }
  return [...selected];
}

export function excludeSourceTarget(
  group: SourceTargetGroup,
  entry: WatchEntry,
  ignored: WatchOptions["ignored"],
): boolean {
  const physical = path.resolve(group.authority.rootReal, entry.path);
  for (const mapping of group.mappings) {
    // A selected path's parents must stay visible, including an intermediate
    // link replacing packages/foo in packages/foo/src. They are not source files.
    if (relativeInside(physical, mapping.physical) !== undefined) {
      return false;
    }
  }
  return sourceTargetPaths(group, entry.path).every((lexical) =>
    ignored(lexical, { isDirectory: () => entry.kind === "directory" || entry.kind === "symlink" }),
  );
}

/** All successful Roots remain pinned, including temporarily unused targets. */
export function createSourceTargetDiscovery(
  cwd: string,
  paths: readonly string[],
  ignored: WatchOptions["ignored"],
) {
  const lexicalRoot = path.resolve(cwd);
  const pinned = new Map<string, Root>();
  let repository: Root | undefined;

  const pinnedRoot = (target: string) =>
    [...pinned.values()]
      .toSorted((a, b) => b.rootReal.length - a.rootReal.length)
      .find((authority) => relativeInside(authority.rootReal, target) !== undefined);

  const targetAuthority = async (target: string, signal: AbortSignal) => {
    // Never re-admit a replaced Root, even after its last alias disappeared.
    const previous = pinnedRoot(target);
    if (previous) {
      return { authority: previous, target };
    }
    const admitted = await admitObservationRoot(path.dirname(target));
    signal.throwIfAborted();
    const canonicalTarget = path.resolve(
      admitted.rootReal,
      path.relative(admitted.rootDir, target),
    );
    const authority = pinnedRoot(canonicalTarget) ?? admitted;
    pinned.set(authority.rootReal, authority);
    return { authority, target: canonicalTarget };
  };

  const discover = async (signal: AbortSignal): Promise<SourceTargetGroup[]> => {
    if (!repository) {
      repository = await root(await fs.realpath(lexicalRoot), { symlinks: "reject" });
      pinned.set(repository.rootReal, repository);
    }
    signal.throwIfAborted();
    const groups = new Map<Root, SourceTargetGroup>();
    const mappings = new Set<string>();
    let examined = 0;
    let directories = 0;
    const checkEntry = () => {
      signal.throwIfAborted();
      if (++examined > SOURCE_OBSERVATION_LIMITS.entries) {
        throw new RangeError("Source link discovery entry budget exceeded");
      }
    };
    const visit = async (
      authority: Root,
      physical: string,
      lexical: string,
      kind: Mapping["kind"],
      hops: number,
    ) => {
      signal.throwIfAborted();
      if (hops > SOURCE_OBSERVATION_LIMITS.linkHops) {
        throw new RangeError("Source link discovery cycle/hop budget exceeded");
      }
      const key = JSON.stringify([physical, lexical, kind]);
      if (mappings.has(key)) {
        return;
      }
      if (mappings.size >= SOURCE_OBSERVATION_LIMITS.mappings) {
        throw new RangeError("Source link discovery mapping budget exceeded");
      }
      mappings.add(key);
      let group = groups.get(authority);
      if (!group) {
        group = { authority, mappings: [], scopes: [] };
        groups.set(authority, group);
      }
      group.mappings.push({ physical, lexical, kind });
      const relative = relativeInside(authority.rootReal, physical);
      if (relative === undefined) {
        throw new Error("Linked source outside admitted Root");
      }
      // Watch from the first component: no physical scope crosses a symbolic
      // parent, even when a formerly ordinary intermediate directory changes.
      const first = relative.split(path.sep)[0] || ".";
      if (!group.scopes.some((scope) => scope.path === first)) {
        group.scopes.push({ path: first, kind: "tree", depth: SOURCE_OBSERVATION_LIMITS.depth });
      }
      const follow = async (
        link: string,
        alias: string,
        suffix: string,
        linkKind: Mapping["kind"],
      ) => {
        signal.throwIfAborted();
        // Link names come from guarded discovery, never advisory notifications.
        if ((await observationPrefixKind(authority, path.dirname(link), signal)) !== "directory") {
          return;
        }
        let text: string;
        try {
          text = await fs.readlink(path.resolve(authority.rootReal, link));
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            ["ENOENT", "ENOTDIR", "EINVAL"].includes(String(error.code))
          ) {
            return;
          }
          throw error;
        }
        signal.throwIfAborted();
        if ((await observationPrefixKind(authority, path.dirname(link), signal)) !== "directory") {
          return;
        }
        const declared = path.resolve(authority.rootReal, path.dirname(link), text);
        const admitted = await targetAuthority(declared, signal);
        await visit(
          admitted.authority,
          path.resolve(admitted.target, suffix),
          alias,
          linkKind,
          hops + 1,
        );
      };
      const parts = relative.split(path.sep).filter(Boolean);
      if (parts.length > SOURCE_OBSERVATION_LIMITS.depth) {
        throw new RangeError("Source selection depth budget exceeded");
      }
      let prefix = "";
      for (const [index, part] of parts.entries()) {
        checkEntry();
        prefix = path.join(prefix, part);
        const found = await observationPrefixKind(authority, prefix, signal);
        if (found === "symlink") {
          await follow(prefix, lexical, parts.slice(index + 1).join(path.sep), kind);
          return;
        }
        if (found !== "directory") {
          return;
        }
      }
      if (kind !== "tree" || ignored(lexical, { isDirectory: () => true })) {
        return;
      }
      const scan = async (directory: string, alias: string, depth: number) => {
        signal.throwIfAborted();
        if (++directories > SOURCE_OBSERVATION_LIMITS.directories) {
          throw new RangeError("Source link discovery directory budget exceeded");
        }
        for await (const entry of authority.entries("./" + directory, {
          symlinks: "reject",
          signal,
          maxEntries: SOURCE_OBSERVATION_LIMITS.entries - examined,
        })) {
          checkEntry();
          const name = path.join(directory, entry.name);
          const mapped = path.join(alias, entry.name);
          if (ignored(mapped, { isDirectory: () => entry.isDirectory || entry.isSymbolicLink })) {
            continue;
          }
          if (entry.isSymbolicLink) {
            await follow(name, mapped, "", "tree");
          } else if (entry.isDirectory) {
            if (depth <= 1) {
              throw new RangeError("Source discovery depth budget exceeded");
            }
            await scan(name, mapped, depth - 1);
          }
        }
      };
      await scan(
        relative,
        lexical,
        SOURCE_OBSERVATION_LIMITS.depth - Math.max(0, parts.length - 1),
      );
    };
    for (const selected of paths) {
      const lexical = path.resolve(lexicalRoot, selected);
      const relative = relativeInside(lexicalRoot, lexical);
      if (relative === undefined) {
        throw new Error("Source watch path must be inside the repository: " + selected);
      }
      await visit(
        repository,
        path.resolve(repository.rootReal, relative),
        lexical,
        runNodeConfigFiles.includes(relative) ? "entry" : "tree",
        0,
      );
    }
    for (const group of groups.values()) {
      group.scopes.sort((a, b) => a.path.localeCompare(b.path));
      group.mappings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return [...groups.values()];
  };
  return {
    async discover(signal: AbortSignal): Promise<SourceTargetGroup[]> {
      // Retry bounded directory/link churn under the same pinned authority.
      for (let pass = 0; ; pass++) {
        try {
          return await discover(signal);
        } catch (error) {
          if (
            signal.aborted ||
            pass >= 3 ||
            !(error instanceof FsSafeError) ||
            !["not-found", "path-mismatch", "symlink"].includes(error.code)
          ) {
            throw error;
          }
        }
      }
    },
  };
}
