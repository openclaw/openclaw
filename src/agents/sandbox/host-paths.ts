/**
 * Host path normalization for sandbox mount policy.
 *
 * Handles POSIX, Windows drive, and namespace-prefixed paths before policy-key comparison.
 */
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

function isWindowsDriveAbsolutePath(raw: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(stripWindowsNamespacePrefix(raw));
}

export function isSandboxHostPathAbsolute(raw: string): boolean {
  const input = stripWindowsNamespacePrefix(raw);
  return input.startsWith("/") || isWindowsDriveAbsolutePath(input);
}

/**
 * Normalize a host path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 * Windows drive-letter paths preserve the drive root and uppercase the drive letter.
 */
export function normalizeSandboxHostPath(raw: string): string {
  const input = stripWindowsNamespacePrefix(raw);
  if (!input) {
    return "/";
  }
  // POSIX backslashes are filename bytes. Only native or explicitly Windows
  // paths use them as separators, including the existing namespace/UNC forms.
  const windows =
    process.platform === "win32" ||
    isWindowsDriveAbsolutePath(input) ||
    raw.startsWith("\\\\") ||
    raw.startsWith("//?/");
  let normalizedInput = windows ? input.replaceAll("\\", "/") : input;
  if (isWindowsDriveAbsolutePath(normalizedInput)) {
    normalizedInput = normalizedInput.charAt(0).toUpperCase() + normalizedInput.slice(1);
  }
  const normalized = posix.normalize(normalizedInput);
  const withoutTrailingSlash = normalized.replace(/\/+$/, "") || "/";
  if (/^[A-Z]:$/.test(withoutTrailingSlash)) {
    return `${withoutTrailingSlash}/`;
  }
  return withoutTrailingSlash;
}

export function getSandboxHostPathPolicyKey(raw: string): string {
  const normalized = normalizeSandboxHostPath(raw);
  if (isWindowsDriveAbsolutePath(normalized)) {
    return normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Resolve a path through the deepest existing ancestor so parent symlinks are honored
 * even when the final source leaf does not exist yet.
 */
export function resolveSandboxHostPathViaExistingAncestor(sourcePath: string): string {
  if (!isSandboxHostPathAbsolute(sourcePath)) {
    return sourcePath;
  }
  if (isWindowsDriveAbsolutePath(sourcePath) && process.platform !== "win32") {
    return normalizeSandboxHostPath(sourcePath);
  }
  return normalizeSandboxHostPath(resolvePathViaExistingAncestorSync(sourcePath));
}
