import { posix } from "node:path";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";

function stripWindowsNamespacePrefix(input: string): string {
  if (input.startsWith("\\\\?\\")) {
    const withoutPrefix = input.slice(4);
    if (withoutPrefix.toUpperCase().startsWith("UNC\\")) {
      return `\\\\${withoutPrefix.slice(4)}`;
    }
    return withoutPrefix;
  }
  if (input.startsWith("//?/")) {
    const withoutPrefix = input.slice(4);
    if (withoutPrefix.toUpperCase().startsWith("UNC/")) {
      return `//${withoutPrefix.slice(4)}`;
    }
    return withoutPrefix;
  }
  return input;
}

/**
 * Normalize a POSIX host path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 */
export function normalizeSandboxHostPath(raw: string): string {
  const trimmed = stripWindowsNamespacePrefix(raw.trim());
  if (!trimmed) {
    return "/";
  }
  const normalized = posix.normalize(trimmed.replaceAll("\\", "/"));
  return normalized.replace(/\/+$/, "") || "/";
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
