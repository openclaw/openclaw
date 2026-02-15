import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Prevent path traversal: resolve and verify the path is absolute. Resolves symlinks including parent dirs. */
export async function safePath(rawPath: string): Promise<string | null> {
  if (!rawPath || rawPath.includes("\0")) {
    return null;
  }
  const resolved = path.resolve(rawPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    // Path doesn't exist yet (write/mkdir) — resolve the deepest existing parent
    // and preserve all non-existent path components as a tail suffix.
    let current = resolved;
    let tail = "";
    while (current !== path.dirname(current)) {
      const parent = path.dirname(current);
      tail = tail ? path.join(path.basename(current), tail) : path.basename(current);
      try {
        const realParent = await fs.realpath(parent);
        return path.join(realParent, tail);
      } catch {
        current = parent;
      }
    }
    // No ancestor could be resolved — reject rather than returning an unresolved path.
    return null;
  }
}

/** Check if a resolved path is within allowed paths. */
export async function isPathAllowed(
  resolvedPath: string,
  allowedPaths: string[],
): Promise<boolean> {
  const paths = allowedPaths.length > 0 ? allowedPaths : [os.homedir()];
  for (const base of paths) {
    let resolvedBase: string;
    try {
      resolvedBase = await fs.realpath(path.resolve(base));
    } catch {
      resolvedBase = path.resolve(base);
    }
    if (resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + path.sep)) {
      return true;
    }
  }
  return false;
}

/** Check if a path is an allowed root itself (prevent deleting root allowed dirs). */
export async function isAllowedRoot(
  resolvedPath: string,
  allowedPaths: string[],
): Promise<boolean> {
  const paths = allowedPaths.length > 0 ? allowedPaths : [os.homedir()];
  for (const base of paths) {
    let resolvedBase: string;
    try {
      resolvedBase = await fs.realpath(path.resolve(base));
    } catch {
      resolvedBase = path.resolve(base);
    }
    if (resolvedPath === resolvedBase) {
      return true;
    }
  }
  return false;
}

/** Sanitize error message to avoid leaking internal paths. */
export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\/[^\s,)]+/g, "[path]");
}

/** Async recursive file name search. */
export async function searchFiles(
  basePath: string,
  query: string,
  maxResults = 50,
  maxDepth = 5,
): Promise<{ path: string; name: string; isDir: boolean }[]> {
  const results: { path: string; name: string; isDir: boolean }[] = [];
  const lowerQuery = query.toLowerCase();
  const visited = new Set<string>();

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || results.length >= maxResults) {
      return;
    }

    // Detect symlink cycles
    try {
      const realDir = await fs.realpath(dir);
      if (visited.has(realDir)) {
        return;
      }
      visited.add(realDir);
    } catch {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied etc
    }
    for (const e of entries) {
      if (results.length >= maxResults) {
        return;
      }
      if (e.name.startsWith(".")) {
        continue; // skip hidden
      }
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(lowerQuery)) {
        results.push({ path: full, name: e.name, isDir: e.isDirectory() });
      }
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      }
    }
  }

  await walk(basePath, 0);
  return results;
}
