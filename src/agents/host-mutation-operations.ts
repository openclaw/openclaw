import fs from "node:fs/promises";
import path from "node:path";
import { resolveRootPath } from "../infra/boundary-path.js";
import { findExistingAncestor, root as fsRoot, FsSafeError } from "../infra/fs-safe.js";
import { createFsAccessError } from "./agent-tools.read.operations.js";
import {
  prepareHostFileMutation,
  writeHostFile,
  type HostFileMutationPreparer,
} from "./host-file-write.js";
import {
  type MemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { expandOsHomePrefix } from "./sessions/tools/path-utils.js";
import { toCanonicalRelativeWorkspacePath, writeHostWorkspaceFile } from "./workspace-file-ops.js";
import { resolveHostWorkspaceRoot, resolveHostRootAsync } from "./workspace-write-scope.js";

export type HostWorkspaceMutationOptions = {
  containmentRoot?: string;
  workspaceOnly?: boolean;
  strictWorkspaceRoot?: boolean;
  abortSignal?: AbortSignal;
  memoryWriteProvenance?: MemoryWriteProvenanceObserver;
  prepareHostFileMutation?: HostFileMutationPreparer;
};

function resolveHostPath(filePath: string): string {
  return path.resolve(expandOsHomePrefix(filePath));
}

async function statHostFile(absolutePath: string) {
  try {
    const stat = await fs.stat(absolutePath);
    return {
      type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    } as const;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function createHostMutationOperations(root: string, options?: HostWorkspaceMutationOptions) {
  const workspaceOnly = options?.workspaceOnly ?? false;

  if (!workspaceOnly) {
    // When workspaceOnly is false, allow writes anywhere on the host
    return withMemoryWriteProvenance(
      {
        writeFile: (filePath: string, content: string) =>
          writeHostFile(filePath, content, options?.abortSignal, options?.prepareHostFileMutation),
        readFile: async (absolutePath: string) => fs.readFile(resolveHostPath(absolutePath)),
        statFile: (absolutePath: string) => statHostFile(resolveHostPath(absolutePath)),
        access: async (absolutePath: string) => {
          await fs.access(resolveHostPath(absolutePath));
        },
      } as const,
      options?.memoryWriteProvenance,
    );
  }

  // When workspaceOnly is true, enforce workspace boundary. Resolve the fs-safe
  // root lazily on first use: constructing the tool (e.g. doctor projecting tool
  // schemas) must not open an fs handle, and a missing workspace dir must not
  // orphan a rejecting promise as "Unhandled promise rejection: root dir not found".
  const roots = new Map<string, ReturnType<typeof fsRoot>>();
  const getRoot = (selectedRoot: string) => {
    let pending = roots.get(selectedRoot);
    if (!pending) {
      pending = fsRoot(selectedRoot);
      roots.set(selectedRoot, pending);
    }
    return pending;
  };
  return withMemoryWriteProvenance(
    {
      mkdir: async (dir: string) => {
        const selectedRoot = await resolveHostRootAsync(root, dir, options?.strictWorkspaceRoot);
        const relative = toRelativeWorkspacePath(selectedRoot, dir, { allowRoot: true });
        // mkdir receives the file's parent, including directory links to the root itself.
        const resolved = await resolveRootPath({
          absolutePath: path.resolve(selectedRoot, relative),
          rootPath: selectedRoot,
          boundaryLabel: "workspace root",
        });
        const ancestor = await findExistingAncestor(resolved.rootCanonicalPath);
        await using effect = await prepareHostFileMutation(
          options?.prepareHostFileMutation,
          options?.abortSignal,
        );
        if (ancestor && ancestor !== resolved.rootCanonicalPath) {
          const ancestorRoot = await fsRoot(ancestor);
          // mkdir requires a relative path; the prefix preserves literal tilde names.
          await ancestorRoot.mkdir(`./${path.relative(ancestor, resolved.rootCanonicalPath)}`, {
            assertBeforeMutation: effect.assertCurrent,
          });
        }
        const rootHandle = await getRoot(selectedRoot);
        const canonicalRelative = toRelativeWorkspacePath(
          rootHandle.rootReal,
          resolved.canonicalPath,
          { allowRoot: true },
        );
        const mutationOptions = {
          mutationSymlinks: "reject" as const,
          assertBeforeMutation: () => {
            effect.assertCurrent();
            toRelativeWorkspacePath(
              resolveHostWorkspaceRoot(root, dir, options?.strictWorkspaceRoot),
              dir,
              { allowRoot: true },
            );
          },
        };
        if (canonicalRelative) {
          await rootHandle.mkdir(`./${canonicalRelative}`, mutationOptions);
        } else {
          await rootHandle.ensureRoot(mutationOptions);
        }
      },
      writeFile: (absolutePath: string, content: string) =>
        writeHostWorkspaceFile(
          root,
          getRoot,
          absolutePath,
          content,
          options?.abortSignal,
          options?.prepareHostFileMutation,
          options?.strictWorkspaceRoot,
        ),
      readFile: async (absolutePath: string) => {
        // Reads retain the workspace contract of following only symlink parents.
        const selectedRoot = await resolveHostRootAsync(
          root,
          absolutePath,
          options?.strictWorkspaceRoot,
        );
        const relative = await toCanonicalRelativeWorkspacePath(selectedRoot, absolutePath);
        const rootHandle = await getRoot(selectedRoot);
        return (await rootHandle.read(path.resolve(rootHandle.rootReal, relative))).buffer;
      },
      statFile: async (absolutePath: string) => {
        const selectedRoot = await resolveHostRootAsync(
          root,
          absolutePath,
          options?.strictWorkspaceRoot,
        );
        const relative = toRelativeWorkspacePath(selectedRoot, absolutePath);
        return statHostFile(path.resolve(selectedRoot, relative));
      },
      access: async (absolutePath: string) => {
        const selectedRoot = await resolveHostRootAsync(
          root,
          absolutePath,
          options?.strictWorkspaceRoot,
        );
        let relative: string;
        try {
          // Canonicalized like readFile so in-workspace symlink parents pass.
          relative = await toCanonicalRelativeWorkspacePath(selectedRoot, absolutePath);
        } catch {
          // Path escapes workspace root.  Don't throw here – the upstream
          // library replaces any `access` error with a misleading "File not
          // found" message.  By returning silently the subsequent `readFile`
          // call will throw the same "Path escapes workspace root" error
          // through a code-path that propagates the original message.
          return;
        }
        try {
          const rootHandle = await getRoot(selectedRoot);
          const opened = await rootHandle.open(path.resolve(rootHandle.rootReal, relative));
          await opened.handle.close().catch(() => {});
        } catch (error) {
          if (error instanceof FsSafeError && error.code === "not-found") {
            throw createFsAccessError("ENOENT", absolutePath);
          }
          if (error instanceof FsSafeError && error.code === "outside-workspace") {
            // Don't throw here – see the comment above about the upstream
            // library swallowing access errors as "File not found".
            return;
          }
          throw error;
        }
      },
    } as const,
    options?.memoryWriteProvenance,
  );
}
