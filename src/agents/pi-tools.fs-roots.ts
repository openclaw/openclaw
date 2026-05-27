import path from "node:path";
import type { FsRoot } from "../config/types.tools.js";
import { isPathInside, normalizeWindowsPathForComparison } from "../infra/path-guards.js";

export type FsRootResolved = FsRoot & { resolvedPath: string };

function pathsEqual(a: string, b: string): boolean {
  if (process.platform === "win32") {
    return normalizeWindowsPathForComparison(a) === normalizeWindowsPathForComparison(b);
  }
  return a === b;
}

export function resolveRoots(roots: FsRoot[]): FsRootResolved[] {
  return roots.map((r) => ({ ...r, resolvedPath: path.resolve(r.path) }));
}

/**
 * Find the most-specific matching root for a candidate path.
 * For overlapping dir roots (e.g., /data ro + /data/project rw),
 * the longest (most-specific) path wins, making root order irrelevant.
 * File roots always take precedence over dir roots for exact matches.
 */
export function findMatchingRoot(
  candidate: string,
  roots: FsRootResolved[],
): FsRootResolved | undefined {
  let bestDir: FsRootResolved | undefined;

  for (const root of roots) {
    if (root.kind === "file") {
      if (pathsEqual(candidate, root.resolvedPath)) {
        return root;
      }
      continue;
    }
    if (!isPathInside(root.resolvedPath, candidate)) {
      continue;
    }
    if (!bestDir || root.resolvedPath.length > bestDir.resolvedPath.length) {
      bestDir = root;
    }
  }

  return bestDir;
}

function throwReadOnlyRootError(resolvedPath: string, match: FsRootResolved): never {
  const label = match.kind === "file" ? "file root" : "root";
  throw new Error(
    `Access denied: path '${resolvedPath}' is inside read-only ${label} '${match.path}'`,
  );
}

export function validatePathAgainstRoots(
  resolvedPath: string,
  operation: "read" | "write",
  roots: FsRootResolved[],
): void {
  const candidate = path.resolve(resolvedPath);
  const match = findMatchingRoot(candidate, roots);

  if (!match) {
    throw new Error(`Access denied: path '${resolvedPath}' is outside allowed filesystem roots`);
  }

  if (operation === "write" && match.access === "ro") {
    throwReadOnlyRootError(resolvedPath, match);
  }
}

export type RootScopedPathTarget = {
  absolutePath: string;
  root: FsRootResolved;
  rootDir: string;
  relativePath: string;
};

export function resolveRootScopedPath(
  resolvedPath: string,
  operation: "read" | "write",
  roots: FsRootResolved[],
): RootScopedPathTarget {
  const absolutePath = path.resolve(resolvedPath);
  const root = findMatchingRoot(absolutePath, roots);

  if (!root) {
    throw new Error(`Access denied: path '${resolvedPath}' is outside allowed filesystem roots`);
  }
  if (operation === "write" && root.access === "ro") {
    throwReadOnlyRootError(resolvedPath, root);
  }

  if (root.kind === "file") {
    return {
      absolutePath,
      root,
      rootDir: path.dirname(root.resolvedPath),
      relativePath: path.basename(root.resolvedPath),
    };
  }

  return {
    absolutePath,
    root,
    rootDir: root.resolvedPath,
    relativePath: path.relative(root.resolvedPath, absolutePath),
  };
}
