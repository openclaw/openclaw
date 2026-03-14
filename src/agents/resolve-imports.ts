import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openVerifiedFileSync } from "../infra/safe-open-sync.js";

const DEFAULT_MAX_DEPTH = 3;
const MAX_IMPORT_FILE_BYTES = 16 * 1024;
const MAX_IMPORT_CONTENT_LENGTH = 4096;
const TRUNCATION_MARKER = "...TRUNCATED...";
const IMPORT_DIRECTIVE_RE = /^\s*@(.+\.md)\s*$/;

export type ResolveImportsOptions = {
  /** Maximum recursion depth for nested imports (default: 3). */
  maxDepth?: number;
  /** Root boundary directories. Resolved imports must be within at least one of these directory trees. */
  boundaryDirs?: string[];
  /** @deprecated use boundaryDirs */
  boundaryDir?: string;
};

/**
 * Expand `@<relative-path>.md` import directives in markdown content.
 *
 * Each directive on its own line is replaced with the contents of the
 * referenced file, resolved relative to the importing file's directory.
 * Nested imports are resolved recursively up to `maxDepth`.
 *
 * Circular imports and depth-exceeded directives are left unexpanded.
 *
 * @param content   - The raw markdown content to process.
 * @param filePath  - Absolute path of the file that contains `content`.
 * @param opts      - Optional settings (maxDepth).
 * @returns The content with all resolvable imports expanded.
 */
export async function resolveImports(
  content: string,
  filePath: string,
  opts?: ResolveImportsOptions,
): Promise<string> {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const visited = new Set<string>();

  // Resolve the boundary directories to canonical paths for comparison.
  const resolvedBoundaries: string[] = [];
  const dirsToResolve = opts?.boundaryDirs ?? (opts?.boundaryDir ? [opts.boundaryDir] : []);
  for (const b of dirsToResolve) {
    if (!b) {
      continue;
    }
    try {
      resolvedBoundaries.push(await fs.realpath(b));
    } catch {
      resolvedBoundaries.push(path.resolve(b));
    }
  }

  // Add the root file itself to the visited set to prevent self-import.
  try {
    visited.add(await fs.realpath(filePath));
  } catch {
    visited.add(path.resolve(filePath));
  }

  return expandImports(
    content,
    filePath,
    maxDepth,
    0,
    visited,
    resolvedBoundaries.length > 0 ? resolvedBoundaries : undefined,
  );
}

async function expandImports(
  content: string,
  filePath: string,
  maxDepth: number,
  currentDepth: number,
  visited: Set<string>,
  boundaryDirs?: string[],
): Promise<string> {
  const lines = content.split("\n");
  const resultLines: string[] = [];

  for (const line of lines) {
    const match = IMPORT_DIRECTIVE_RE.exec(line);
    if (!match) {
      resultLines.push(line);
      continue;
    }

    // Directive found — try to expand it.
    const importRelPath = match[1].trim();
    const importDir = path.dirname(filePath);
    const importAbsPath = path.resolve(importDir, importRelPath);

    // Depth check.
    if (currentDepth >= maxDepth) {
      resultLines.push(line);
      continue;
    }

    // Resolve canonical path for cycle detection.
    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(importAbsPath);
    } catch {
      // File doesn't exist — replace directive with an empty string.
      resultLines.push("");
      continue;
    }

    // Cycle detection.
    if (visited.has(canonicalPath)) {
      resultLines.push(line);
      continue;
    }

    // Boundary check — imported file must be within at least one allowed directory tree.
    // Ensure no double-separator when boundaryDir is a filesystem root (e.g. "/" or "C:\").
    if (boundaryDirs && boundaryDirs.length > 0) {
      const isInsideAny = boundaryDirs.some((bd) => {
        const boundaryPrefix = bd.endsWith(path.sep) ? bd : bd + path.sep;
        return canonicalPath.startsWith(boundaryPrefix) || canonicalPath === bd;
      });
      if (!isInsideAny) {
        resultLines.push(line);
        continue;
      }
    }

    // Read the imported file via verified fd-open to prevent TOCTOU races.
    // openVerifiedFileSync atomically opens, validates identity (hardlink
    // rejection, size cap, regular-file check), and returns an fd safe to read.
    let importedContent: string;
    try {
      const opened = openVerifiedFileSync({
        filePath: canonicalPath,
        rejectHardlinks: true,
        rejectPathSymlink: true,
        maxBytes: MAX_IMPORT_FILE_BYTES,
      });
      if (!opened.ok) {
        resultLines.push(line);
        continue;
      }
      try {
        importedContent = syncFs.readFileSync(opened.fd, "utf-8");
      } finally {
        syncFs.closeSync(opened.fd);
      }
    } catch {
      // Read failure — replace directive with an empty string.
      resultLines.push("");
      continue;
    }

    // Recurse into the imported content.
    const branchVisited = new Set(visited);
    branchVisited.add(canonicalPath);

    const expanded = await expandImports(
      importedContent,
      canonicalPath,
      maxDepth,
      currentDepth + 1,
      branchVisited,
      boundaryDirs,
    );

    // Truncate if expanded content exceeds 4K.
    let final = expanded;
    if (final.length > MAX_IMPORT_CONTENT_LENGTH) {
      final =
        final.slice(0, MAX_IMPORT_CONTENT_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
    }

    // Strip trailing newline to avoid double-newlines when joining.
    if (final.endsWith("\n")) {
      final = final.slice(0, -1);
    }
    resultLines.push(final);
  }

  return resultLines.join("\n");
}
