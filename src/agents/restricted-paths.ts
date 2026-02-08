/**
 * Restricted path validation for LLM file operations.
 *
 * This module prevents the LLM from writing to security-sensitive directories
 * like hooks directories, which could be exploited for code injection attacks.
 *
 * @see VULN-201: Workspace Hook Code Injection via LLM File Write
 */

import os from "node:os";
import path from "node:path";
import { CONFIG_DIR } from "../utils.js";

/**
 * Path patterns that are restricted for LLM write operations.
 * These paths could be exploited for code injection if the LLM is tricked
 * into writing malicious code to them.
 */
const RESTRICTED_PATH_PATTERNS = [
  // Hooks directories - workspace hooks have highest precedence and run with full privileges
  "hooks",
] as const;

/**
 * Normalizes a path by expanding ~ and resolving to absolute path.
 */
function normalizePath(filePath: string, cwd: string): string {
  let normalized = filePath;

  // Expand ~
  if (normalized === "~") {
    normalized = os.homedir();
  } else if (normalized.startsWith("~/")) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }

  // Resolve to absolute path
  if (!path.isAbsolute(normalized)) {
    normalized = path.resolve(cwd, normalized);
  }

  // Normalize path (resolve . and ..)
  return path.normalize(normalized);
}

/**
 * Checks if a path is within or targets a restricted directory.
 *
 * A path is considered restricted if it contains a path segment that exactly
 * matches a restricted pattern. This means:
 * - /workspace/hooks/handler.ts - BLOCKED (contains "hooks" segment)
 * - /workspace/hooks - BLOCKED (contains "hooks" segment)
 * - /workspace/webhook/handler.ts - ALLOWED ("webhook" != "hooks")
 * - /workspace/hooks-backup/handler.ts - ALLOWED ("hooks-backup" != "hooks")
 */
function isRestrictedPath(resolvedPath: string): { restricted: boolean; pattern?: string } {
  const segments = resolvedPath.split(path.sep);

  for (const pattern of RESTRICTED_PATH_PATTERNS) {
    // Check if any segment exactly matches the pattern
    if (segments.includes(pattern)) {
      return { restricted: true, pattern };
    }
  }

  return { restricted: false };
}

/**
 * Checks if the resolved path is within the CONFIG_DIR hooks directory.
 * This catches writes to ~/.openclaw/hooks/ even if the workspace is elsewhere.
 */
function isConfigDirHooksPath(resolvedPath: string): boolean {
  const configHooksDir = path.join(CONFIG_DIR, "hooks");
  const normalizedResolved = path.normalize(resolvedPath);
  const normalizedConfigHooks = path.normalize(configHooksDir);

  // Check if the resolved path starts with the config hooks directory
  return (
    normalizedResolved === normalizedConfigHooks ||
    normalizedResolved.startsWith(normalizedConfigHooks + path.sep)
  );
}

export interface RestrictedPathCheckResult {
  restricted: boolean;
  reason?: string;
}

/**
 * Validates that a file path is not targeting a restricted directory.
 *
 * @param filePath - The file path from the tool parameters
 * @param cwd - The current working directory (workspace root)
 * @returns Result indicating if the path is restricted and why
 */
export function checkRestrictedPath(filePath: string, cwd: string): RestrictedPathCheckResult {
  const resolved = normalizePath(filePath, cwd);

  // Check if targeting CONFIG_DIR hooks
  if (isConfigDirHooksPath(resolved)) {
    return {
      restricted: true,
      reason: `Writing to hooks directory is restricted for security reasons (code injection risk). Path: ${filePath}`,
    };
  }

  // Check for restricted path patterns in workspace
  const { restricted, pattern } = isRestrictedPath(resolved);
  if (restricted) {
    return {
      restricted: true,
      reason: `Writing to ${pattern} directory is restricted for security reasons (code injection risk). Path: ${filePath}`,
    };
  }

  return { restricted: false };
}

/**
 * Asserts that a file path is not targeting a restricted directory.
 * Throws an error if the path is restricted.
 *
 * @param filePath - The file path from the tool parameters
 * @param cwd - The current working directory (workspace root)
 * @throws Error if the path targets a restricted directory
 */
export function assertNotRestrictedPath(filePath: string, cwd: string): void {
  const result = checkRestrictedPath(filePath, cwd);
  if (result.restricted) {
    throw new Error(result.reason);
  }
}
