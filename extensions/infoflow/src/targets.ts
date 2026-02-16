/**
 * Infoflow target resolution utilities.
 * Handles user and group ID formats for message targeting.
 */

import { getInfoflowSendLog } from "./logging.js";
import { getInfoflowRuntime } from "./runtime.js";

// ---------------------------------------------------------------------------
// Target Format Constants
// ---------------------------------------------------------------------------

/** Prefix for group targets: "group:123456" */
const GROUP_PREFIX = "group:";

/** Prefix for user targets (optional): "user:chengbo05" */
const USER_PREFIX = "user:";

// ---------------------------------------------------------------------------
// Target Normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes an Infoflow target string.
 * Strips channel prefix and normalizes format.
 *
 * Examples:
 *   "infoflow:chengbo05" -> "chengbo05"
 *   "infoflow:group:123456" -> "group:123456"
 *   "user:chengbo05" -> "chengbo05"
 *   "group:123456" -> "group:123456"
 *   "chengbo05" -> "chengbo05"
 *   "123456" -> "group:123456" (pure digits treated as group)
 */
export function normalizeInfoflowTarget(raw: string): string | undefined {
  // Get verbose state once at start
  let verbose = false;
  try {
    verbose = getInfoflowRuntime().logging.shouldLogVerbose();
  } catch {
    // runtime not available, keep verbose = false
  }

  if (verbose) {
    getInfoflowSendLog().debug?.(`[infoflow:normalizeTarget] input: "${raw}"`);
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    if (verbose) {
      getInfoflowSendLog().debug?.(`[infoflow:normalizeTarget] empty input, returning undefined`);
    }
    return undefined;
  }

  // Strip infoflow: prefix
  let target = trimmed.replace(/^infoflow:/i, "");

  // Strip user: prefix (normalize to plain username)
  if (target.toLowerCase().startsWith(USER_PREFIX)) {
    target = target.slice(USER_PREFIX.length);
  }

  // Keep group: prefix as-is
  if (target.toLowerCase().startsWith(GROUP_PREFIX)) {
    if (verbose) {
      getInfoflowSendLog().debug?.(`[infoflow:normalizeTarget] output: "${target}" (group)`);
    }
    return target;
  }

  // Pure digits -> treat as group ID
  if (/^\d+$/.test(target)) {
    const result = `${GROUP_PREFIX}${target}`;
    if (verbose) {
      getInfoflowSendLog().debug?.(
        `[infoflow:normalizeTarget] output: "${result}" (digits -> group)`,
      );
    }
    return result;
  }

  // Otherwise it's a username
  if (verbose) {
    getInfoflowSendLog().debug?.(`[infoflow:normalizeTarget] output: "${target}" (username)`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Target ID Detection
// ---------------------------------------------------------------------------

/**
 * Checks if the input looks like a valid Infoflow target ID.
 * Returns true if the system should use this value directly without directory lookup.
 *
 * Valid formats:
 * - group:123456 (group ID with prefix)
 * - user:chengbo05 (user ID with prefix)
 * - 123456789 (pure digits = group ID)
 * - chengbo05 (alphanumeric starting with letter = username/uuapName)
 */
export function looksLikeInfoflowId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  // Strip infoflow: prefix for checking
  const target = trimmed.replace(/^infoflow:/i, "");

  // Explicit prefixes are always valid
  if (/^(group|user):/i.test(target)) {
    return true;
  }

  // Pure digits (group ID)
  if (/^\d+$/.test(target)) {
    return true;
  }

  // Alphanumeric starting with letter (username/uuapName)
  // e.g., chengbo05, zhangsan, user123
  if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(target)) {
    return true;
  }

  return false;
}
