import { posix } from "node:path";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";

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
  return normalizeSandboxHostPath(resolvePathViaExistingAncestorSync(sourcePath));
}
