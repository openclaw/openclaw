import path from "node:path";

// Retain fs-safe's process configuration for host-side memory file operations.
export { root } from "@openclaw/fs-safe/root";
export { isPathInside } from "@openclaw/fs-safe/path";
export { readRegularFile, statRegularFile } from "@openclaw/fs-safe/advanced";
export { walkDirectory } from "@openclaw/fs-safe/walk";

export function normalizeComparablePath(pathname: string): string {
  const resolved = path.resolve(pathname);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * True for missing-file errors emitted by Node or fs-safe.
 * The narrowed union stays stable; extra-path authorization handles `not-file` separately.
 */
export function isFileMissingError(
  err: unknown,
): err is NodeJS.ErrnoException & { code: "ENOENT" | "ENOTDIR" | "not-file" | "not-found" } {
  if (!err || typeof err !== "object" || !("code" in err)) {
    return false;
  }
  return (
    err.code === "ENOENT" ||
    err.code === "ENOTDIR" ||
    err.code === "not-file" ||
    err.code === "not-found"
  );
}
