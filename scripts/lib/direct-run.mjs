// Compares direct-run paths and module URLs across POSIX and Windows path rules.
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Return whether a direct-run path points at the current module path.
 * @internal Directly tested script implementation detail.
 * @param {string | undefined} directPath
 * @param {string | undefined} modulePath
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isDirectRunPath(directPath, modulePath, platform = process.platform) {
  if (!directPath || !modulePath) {
    return false;
  }
  const pathImpl = platform === "win32" ? path.win32 : path;
  /** @type {(value: string) => string} */
  const normalize =
    platform === "win32"
      ? (value) => pathImpl.resolve(value).toLowerCase()
      : (value) => pathImpl.resolve(value);
  return normalize(directPath) === normalize(modulePath);
}

/**
 * Return whether a direct-run path points at the current module URL.
 * @param {string | undefined} directPath
 * @param {string} moduleUrl
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isDirectRunUrl(directPath, moduleUrl, platform = process.platform) {
  const modulePath = fileURLToPath(moduleUrl);
  if (isDirectRunPath(directPath, modulePath, platform)) {
    return true;
  }
  if (!directPath) {
    return false;
  }
  try {
    // The module loader resolves symlinks by default, but argv retains the authored path.
    return isDirectRunPath(realpathSync(directPath), modulePath, platform);
  } catch {
    // Importers can have an argv entry with no corresponding file.
    return false;
  }
}
