import path from "node:path";
import type { FsRoot } from "../config/types.tools.js";
import { resolvePathViaExistingAncestor } from "../infra/boundary-path.js";
import { assertNoPathAliasEscape, PATH_ALIAS_POLICIES } from "../infra/path-alias-guards.js";
import { isPathInside, normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { normalizeToolParams } from "./pi-tools.params.js";
import { resolveToolPathAgainstWorkspaceRoot } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

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
        return root; // exact file match — highest precedence
      }
      continue;
    }
    // kind === "dir"
    if (!isPathInside(root.resolvedPath, candidate)) {
      continue;
    }
    // Pick the most-specific (longest path) dir root
    if (!bestDir || root.resolvedPath.length > bestDir.resolvedPath.length) {
      bestDir = root;
    }
  }

  return bestDir;
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

function throwReadOnlyRootError(resolvedPath: string, match: FsRootResolved): never {
  const label = match.kind === "file" ? "file root" : "root";
  throw new Error(
    `Access denied: path '${resolvedPath}' is inside read-only ${label} '${match.path}'`,
  );
}

function sortRootsForMatching(roots: FsRootResolved[]): FsRootResolved[] {
  return [...roots].toSorted((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "file" ? -1 : 1;
    }
    if (left.resolvedPath.length !== right.resolvedPath.length) {
      return right.resolvedPath.length - left.resolvedPath.length;
    }
    if (left.access !== right.access) {
      return left.access === "ro" ? -1 : 1;
    }
    return left.resolvedPath.localeCompare(right.resolvedPath);
  });
}

async function validateCanonicalTargetAgainstRoots(
  resolvedPath: string,
  operation: "read" | "write",
  roots: FsRootResolved[],
): Promise<void> {
  const canonicalPath = path.resolve(await resolvePathViaExistingAncestor(resolvedPath));
  const canonicalRoots = sortRootsForMatching(
    await Promise.all(
      roots.map(async (root) => ({
        ...root,
        resolvedPath: path.resolve(await resolvePathViaExistingAncestor(root.resolvedPath)),
      })),
    ),
  );

  const match = findMatchingRoot(canonicalPath, canonicalRoots);
  if (!match) {
    throw new Error(
      `Access denied: canonical target for '${resolvedPath}' is outside allowed filesystem roots`,
    );
  }

  if (operation === "write" && match.access === "ro") {
    throwReadOnlyRootError(resolvedPath, match);
  }
}

/**
 * After lexical root matching, verify the path doesn't escape via symlink/hardlink.
 * Reuses OpenClaw's existing alias-safe boundary helpers.
 */
export async function assertAliasSafe(
  resolvedPath: string,
  roots: FsRootResolved[],
  options?: {
    allowFinalSymlinkForUnlink?: boolean;
    allowFinalHardlinkForUnlink?: boolean;
    operation?: "read" | "write";
  },
): Promise<void> {
  const candidate = path.resolve(resolvedPath);
  const match = findMatchingRoot(candidate, roots);
  if (!match) {
    return;
  } // no match — validatePathAgainstRoots already threw

  const policy =
    options?.allowFinalSymlinkForUnlink || options?.allowFinalHardlinkForUnlink
      ? {
          allowFinalSymlinkForUnlink: options.allowFinalSymlinkForUnlink,
          allowFinalHardlinkForUnlink: options.allowFinalHardlinkForUnlink,
        }
      : PATH_ALIAS_POLICIES.strict;

  await assertNoPathAliasEscape({
    absolutePath: candidate,
    rootPath: match.resolvedPath,
    boundaryLabel: `fs root '${match.path}'`,
    policy,
  });

  if (options?.allowFinalSymlinkForUnlink || options?.allowFinalHardlinkForUnlink) {
    return;
  }

  await validateCanonicalTargetAgainstRoots(resolvedPath, options?.operation ?? "read", roots);
}

export function wrapToolMultiRootGuard(
  tool: AnyAgentTool,
  workspaceRoot: string,
  roots: FsRootResolved[],
  options?: { containerWorkdir?: string },
): AnyAgentTool {
  const isWriteTool = tool.name === "write" || tool.name === "edit";
  const operation = isWriteTool ? ("write" as const) : ("read" as const);

  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      const filePath = record?.path;

      if (typeof filePath !== "string" || !filePath.trim()) {
        console.debug(
          `[tools.fs.roots] wrapToolMultiRootGuard: could not extract filePath from args for tool '${tool.name}', skipping roots check`,
        );
      } else {
        const resolved = resolveToolPathAgainstWorkspaceRoot({
          filePath,
          root: workspaceRoot,
          containerWorkdir: options?.containerWorkdir,
        });
        // Step 1: lexical root matching + access mode check
        validatePathAgainstRoots(resolved, operation, roots);
        // Step 2: alias-safe check (symlinks, hardlinks)
        await assertAliasSafe(resolved, roots, { operation });
      }

      return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
    },
  };
}
