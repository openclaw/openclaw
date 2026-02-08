/**
 * Restricted paths validation for filesystem tools.
 *
 * Prevents LLM agents from writing to sensitive directories that could enable
 * persistent code execution or credential theft:
 *
 * - <workspace>/hooks - Workspace hooks directory (loaded with highest precedence)
 * - ~/.openclaw/hooks - Managed hooks directory
 * - ~/.openclaw/credentials - Credential storage
 *
 * Related: VULN-201 (Workspace Hook Code Injection via LLM File Write)
 */

import os from "node:os";
import path from "node:path";
import { resolveConfigDir } from "../utils.js";

/**
 * Error thrown when attempting to write to a restricted path.
 */
export class RestrictedPathError extends Error {
  constructor(filePath: string) {
    super(
      `Access denied: Writing to ${filePath} is restricted for security reasons. ` +
        `Hook files and credentials must be managed through approved installation methods.`,
    );
    this.name = "RestrictedPathError";
  }
}

/**
 * Restricted directory patterns relative to config directory (~/.openclaw/).
 * These are absolute paths that should never be writable by LLM agents.
 */
const CONFIG_RESTRICTED_SUBDIRS = ["hooks", "credentials"] as const;

/**
 * Restricted directory name within workspace.
 */
const WORKSPACE_RESTRICTED_DIR = "hooks";

/**
 * Expands tilde (~) to home directory.
 */
function expandTilde(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Normalizes a path by expanding tilde and resolving to absolute path.
 */
function normalizePath(filePath: string, cwd?: string): string {
  const expanded = expandTilde(filePath);
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.normalize(path.resolve(cwd ?? process.cwd(), expanded));
}

/**
 * Checks if a normalized path is under a given directory.
 */
function isUnderDirectory(filePath: string, directory: string): boolean {
  const normalizedDir = path.normalize(directory);
  const normalizedFile = path.normalize(filePath);

  // Check if the file path starts with the directory path
  if (!normalizedFile.startsWith(normalizedDir)) {
    return false;
  }

  // Ensure it's a proper subdirectory (not just prefix match)
  // e.g., /foo/bar should not match /foo/barbaz
  const remainder = normalizedFile.slice(normalizedDir.length);
  return remainder === "" || remainder.startsWith(path.sep);
}

/**
 * Checks if a file path points to a restricted location.
 *
 * Restricted locations include:
 * - <workspace>/hooks/** - Workspace hooks (VULN-201)
 * - ~/.openclaw/hooks/** - Managed hooks
 * - ~/.openclaw/credentials/** - Credential files
 *
 * @param params.filePath - The file path to check (can be relative or absolute)
 * @param params.workspaceDir - The current workspace directory
 * @param params.configDir - Optional override for config directory (for testing)
 * @returns true if the path is restricted, false otherwise
 */
export function isRestrictedPath(params: {
  filePath: string;
  workspaceDir: string;
  configDir?: string;
}): boolean {
  const { filePath, workspaceDir, configDir: configDirOverride } = params;

  // Normalize the input path
  const normalizedPath = normalizePath(filePath, workspaceDir);

  // Check workspace hooks directory
  const workspaceHooksDir = path.join(workspaceDir, WORKSPACE_RESTRICTED_DIR);
  if (isUnderDirectory(normalizedPath, workspaceHooksDir)) {
    return true;
  }

  // Check config directory restricted paths
  const configDir = configDirOverride ?? resolveConfigDir();
  for (const subdir of CONFIG_RESTRICTED_SUBDIRS) {
    const restrictedDir = path.join(configDir, subdir);
    if (isUnderDirectory(normalizedPath, restrictedDir)) {
      return true;
    }
  }

  return false;
}

/**
 * Asserts that a file path is not restricted.
 * Throws RestrictedPathError if the path is restricted.
 */
export function assertNotRestrictedPath(params: {
  filePath: string;
  workspaceDir: string;
  configDir?: string;
}): void {
  if (isRestrictedPath(params)) {
    throw new RestrictedPathError(params.filePath);
  }
}
