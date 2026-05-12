import path from "node:path";

const PROTECTED_HOME = path.resolve("/Users/anandsagar/.openclaw");

function isInsideProtectedHome(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return resolved === PROTECTED_HOME || resolved.startsWith(`${PROTECTED_HOME}${path.sep}`);
}

/**
 * Validates that the given path is NOT inside the protected production OpenClaw directory.
 * This is a lab safety guard to prevent accidental modification of real production data.
 */
export function assertPathIsSafe(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  if (isInsideProtectedHome(resolved)) {
    throw new Error(`SAFETY BREACH: Path is inside protected production home: ${resolved}`);
  }
}

/**
 * Validates that a list of paths are all safe.
 */
export function assertPathsAreSafe(paths: string[]): void {
  for (const p of paths) {
    assertPathIsSafe(p);
  }
}
