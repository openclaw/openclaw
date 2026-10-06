// Shared parsing, diffing, and reporting helpers for inventory guard scripts.
import path from "node:path";
import { visitModuleSpecifiers } from "./ts-guard-utils.mts";

/** Convert an absolute file path to a repo-relative POSIX path. */
export function normalizeRepoPath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

/** Resolve a relative or absolute module specifier to a repo-relative path. */
export function resolveRepoSpecifier(repoRoot, specifier, importerFile) {
  if (specifier.startsWith(".")) {
    return normalizeRepoPath(repoRoot, path.resolve(path.dirname(importerFile), specifier));
  }
  if (specifier.startsWith("/")) {
    return normalizeRepoPath(repoRoot, specifier);
  }
  return null;
}

/** Write one line to a stream without each caller repeating newline handling. */
export function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

/**
 * Collect module references from a source file owned by the caller's parsing session.
 *
 * @param {import("typescript/unstable/ast").SourceFile} sourceFile
 * @param {{
 *   acceptSpecifier?: (specifier: string) => boolean;
 * }} [options]
 * @returns {Array<{ kind: string; line: number; specifier: string }>}
 */
export function collectModuleReferencesFromSource(sourceFile, options = {}) {
  const acceptSpecifier = options.acceptSpecifier ?? (() => true);
  const references = [];
  visitModuleSpecifiers(
    sourceFile,
    ({ kind, specifier, specifierNode }) => {
      if (acceptSpecifier(specifier)) {
        references.push({
          kind,
          line:
            sourceFile.getLineAndCharacterOfPosition(specifierNode.getStart(sourceFile)).line + 1,
          specifier,
        });
      }
    },
    { includeCommonJs: true, includeImportMetaUrl: true, includeImportTypes: true },
  );

  return references.toSorted(
    (left, right) =>
      left.line - right.line ||
      left.kind.localeCompare(right.kind) ||
      left.specifier.localeCompare(right.specifier),
  );
}

/** Memoize an async factory while resetting the cache after failures. */
export function createCachedAsync(factory) {
  let cachedPromise = null;
  return async function getCachedValue() {
    if (cachedPromise) {
      return cachedPromise;
    }

    cachedPromise = factory();
    try {
      return await cachedPromise;
    } catch (error) {
      cachedPromise = null;
      throw error;
    }
  };
}

/** Format grouped inventory entries for human-readable guard output. */
export function formatGroupedInventoryHuman(params, inventory) {
  if (inventory.length === 0) {
    return `${params.rule}\n${params.cleanMessage}`;
  }

  const lines = [params.rule, params.inventoryTitle];
  let activeFile = "";
  for (const entry of inventory) {
    if (entry.file !== activeFile) {
      activeFile = entry.file;
      lines.push(activeFile);
    }
    lines.push(`  - line ${entry.line} [${entry.kind}] ${entry.reason}`);
    lines.push(`    specifier: ${entry.specifier}`);
    lines.push(`    resolved: ${entry.resolvedPath}`);
  }
  return lines.join("\n");
}
