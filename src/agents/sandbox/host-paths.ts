import { existsSync, realpathSync } from "node:fs";
import { posix } from "node:path";

/**
 * Normalize a POSIX host path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 */
export function normalizeSandboxHostPath(raw: string): string {
  const trimmed = raw.trim();
  return posix.normalize(trimmed).replace(/\/+$/, "") || "/";
}

/**
 * Resolve a path through the deepest existing ancestor so parent symlinks are honored
 * even when the final source leaf does not exist yet.
 */
export function resolveSandboxHostPathViaExistingAncestor(sourcePath: string): string {
  if (!sourcePath.startsWith("/")) {
    return sourcePath;
  }

  const normalized = normalizeSandboxHostPath(sourcePath);
  let current = normalized;
  const missingSegments: string[] = [];

  while (current !== "/" && !existsSync(current)) {
    missingSegments.unshift(posix.basename(current));
    const parent = posix.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  if (!existsSync(current)) {
    return normalized;
  }

  try {
    const resolvedAncestor = normalizeSandboxHostPath(realpathSync.native(current));
    if (missingSegments.length === 0) {
      return resolvedAncestor;
    }
    return normalizeSandboxHostPath(posix.join(resolvedAncestor, ...missingSegments));
  } catch {
    return normalized;
  }
}
