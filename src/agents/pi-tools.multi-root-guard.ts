import path from "node:path";
import { resolvePathViaExistingAncestor } from "../infra/boundary-path.js";
import { assertNoPathAliasEscape, PATH_ALIAS_POLICIES } from "../infra/path-alias-guards.js";
import {
  findMatchingRoot,
  resolveRoots,
  type FsRootResolved,
  validatePathAgainstRoots,
} from "./pi-tools.fs-roots.js";
import { getToolParamsRecord } from "./pi-tools.params.js";
import { resolveToolPathAgainstWorkspaceRoot } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

export { findMatchingRoot, resolveRoots, type FsRootResolved, validatePathAgainstRoots };

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
  options?: { allowMissingCanonicalMatch?: boolean },
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
    if (options?.allowMissingCanonicalMatch) {
      return;
    }
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
  const allowMissingCanonicalMatch =
    options?.allowFinalSymlinkForUnlink || options?.allowFinalHardlinkForUnlink;

  await assertNoPathAliasEscape({
    absolutePath: candidate,
    rootPath: match.resolvedPath,
    boundaryLabel: `fs root '${match.path}'`,
    policy,
  });

  await validateCanonicalTargetAgainstRoots(resolvedPath, options?.operation ?? "read", roots, {
    allowMissingCanonicalMatch,
  });
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
      const record = getToolParamsRecord(args);
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

      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}
