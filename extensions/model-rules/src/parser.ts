import { constants as fsConstants, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

const MAX_CACHE_ENTRIES = 64;
const MAX_FILE_BYTES = 512 * 1024; // 512 KB — far beyond any reasonable MODELS.md
const fileCache = new Map<string, { content: string; mtimeMs: number }>();

const supportsNoFollow = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const readFlags =
  fsConstants.O_RDONLY |
  (supportsNoFollow ? (fsConstants as Record<string, number>).O_NOFOLLOW : 0);

/**
 * Read MODELS.md from the workspace directory with mtime-based caching.
 * Supports multiple concurrent workspaces without cache thrashing.
 * Rejects symlinks via O_NOFOLLOW on POSIX (ELOOP on symlink open).
 * On Windows, symlinks are not explicitly blocked but require elevated
 * privileges to create; the lexical boundary check prevents path escapes.
 */
export async function readModelsFile(
  workspaceDir: string,
  filename: string = "MODELS.md",
): Promise<string | null> {
  if (!filename || !filename.trim()) {
    return null;
  }
  const filePath = resolve(workspaceDir, filename);
  const resolvedWorkspace = resolve(workspaceDir);
  const boundary = resolvedWorkspace.endsWith(sep) ? resolvedWorkspace : resolvedWorkspace + sep;
  if (!filePath.startsWith(boundary)) {
    return null;
  }
  try {
    // Canonical path check: resolve symlinked parent directories and verify
    // the real target is still inside the real workspace root.
    const realFile = await realpath(filePath);
    const realWorkspace = await realpath(workspaceDir);
    const realBoundary = realWorkspace + sep;
    if (!realFile.startsWith(realBoundary)) {
      return null;
    }
    const fd = await open(filePath, readFlags);
    try {
      const fileInfo = await fd.stat();
      if (!fileInfo.isFile() || fileInfo.size > MAX_FILE_BYTES) {
        return null;
      }
      const cached = fileCache.get(filePath);
      if (cached && fileInfo.mtimeMs === cached.mtimeMs) {
        return cached.content;
      }
      const content = await fd.readFile("utf-8");
      if (fileCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = fileCache.keys().next().value;
        if (oldest !== undefined) {
          fileCache.delete(oldest);
        }
      }
      fileCache.set(filePath, { content, mtimeMs: fileInfo.mtimeMs });
      return content;
    } finally {
      await fd.close();
    }
  } catch {
    fileCache.delete(filePath);
    return null;
  }
}

/** Reset the file cache (for testing). */
export function resetFileCache(): void {
  fileCache.clear();
}

const HEADING_PREFIX = "## MODEL:";
const HEADING_PREFIX_LOWER = HEADING_PREFIX.toLowerCase();

/**
 * Extract a single model section from MODELS.md content by exact model ID.
 * Uses indexOf for the common case, regex fallback for case-insensitive.
 */
export function extractSection(content: string, modelId: string): string | null {
  if (!modelId) {
    return null;
  }

  const target = `${HEADING_PREFIX} ${modelId}`;
  let headingEnd = findHeadingEnd(content, target);

  if (headingEnd === -1) {
    const targetLower = target.toLowerCase();
    const contentLower = content.toLowerCase();
    headingEnd = findHeadingEnd(contentLower, targetLower);
    if (headingEnd === -1) {
      return null;
    }
  }

  const rest = content.slice(headingEnd);
  const nextIdx = findNextHeading(rest);
  const body = nextIdx === -1 ? rest : rest.slice(0, nextIdx);

  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Find the end position of a heading line matching `target` exactly.
 * Returns the index right after the newline, or -1 if not found.
 */
function findHeadingEnd(content: string, target: string): number {
  let pos = 0;
  while (true) {
    const idx = content.indexOf(target, pos);
    if (idx === -1) {
      return -1;
    }

    if (idx > 0 && content[idx - 1] !== "\n") {
      pos = idx + 1;
      continue;
    }

    const afterTarget = idx + target.length;
    // Skip any trailing horizontal whitespace (spaces, tabs) after model id
    let wsEnd = afterTarget;
    while (wsEnd < content.length && (content[wsEnd] === " " || content[wsEnd] === "\t")) {
      wsEnd++;
    }
    const endChar = content[wsEnd];
    if (endChar === undefined || endChar === "\n" || endChar === "\r") {
      const newlineIdx = content.indexOf("\n", afterTarget);
      return newlineIdx === -1 ? content.length : newlineIdx + 1;
    }

    pos = afterTarget;
  }
}

/** Find the start of the next `## MODEL:` heading in `rest` (case-insensitive). */
function findNextHeading(rest: string): number {
  const restLower = rest.toLowerCase();
  let pos = 0;
  while (true) {
    const idx = restLower.indexOf(HEADING_PREFIX_LOWER, pos);
    if (idx === -1) {
      return -1;
    }
    if (idx === 0 || rest[idx - 1] === "\n") {
      return idx;
    }
    pos = idx + 1;
  }
}

/**
 * Parse an OpenClaw model ref into provider and bare model ID.
 * Splits on the last `/` so nested refs like `openrouter/anthropic/claude-sonnet-4-6`
 * produce `bareId: "claude-sonnet-4-6"` (not `"anthropic/claude-sonnet-4-6"`).
 */
export function parseModelRef(modelRef: string): {
  fullRef: string;
  bareId: string;
} {
  const trimmed = modelRef.trim();
  const slashIndex = trimmed.lastIndexOf("/");
  if (slashIndex === -1) {
    return { fullRef: trimmed, bareId: trimmed };
  }
  return {
    fullRef: trimmed,
    bareId: trimmed.slice(slashIndex + 1),
  };
}

/**
 * Find the corrective rules for a model by exact ID match.
 *
 * Lookup order:
 * 1. Full ref (e.g., `openai/gpt-5.4`)
 * 2. Bare model ID (e.g., `gpt-5.4`)
 * 3. No match -> null (zero tokens injected)
 */
export function findModelSection(content: string, modelRef: string): string | null {
  const { fullRef, bareId } = parseModelRef(modelRef);

  if (fullRef !== bareId) {
    const fullMatch = extractSection(content, fullRef);
    if (fullMatch) {
      return fullMatch;
    }
  }

  return extractSection(content, bareId);
}
