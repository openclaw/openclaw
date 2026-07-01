/**
 * Shell command plans for sandbox filesystem bridge operations.
 *
 * Plans carry path-safety checks alongside the command so rechecks and execution stay coupled.
 */
import type { AnchoredSandboxEntry, PathSafetyCheck } from "./fs-bridge-path-safety.js";
import type { SandboxResolvedFsPath } from "./fs-paths.js";

export type SandboxFsCommandPlan = {
  checks: PathSafetyCheck[];
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  recheckBeforeCommand?: boolean;
  allowFailure?: boolean;
};

/**
 * Exit code reserved for a stat whose parent directory does not exist. Shell
 * `cd` failure text differs across dash/bash/busybox, so callers match this
 * code instead of stderr to report not-found rather than a bridge error.
 */
export const SANDBOX_STAT_PARENT_NOT_FOUND_EXIT_CODE = 44;

/** Builds a stat command that anchors the path at its canonical parent before reading metadata. */
export function buildStatPlan(
  target: SandboxResolvedFsPath,
  anchoredTarget: AnchoredSandboxEntry,
  // Stat accepts files and directories; the boundary open defaults to files
  // only, so directory targets must declare themselves to pass the check.
  allowedType?: "file" | "directory",
): SandboxFsCommandPlan {
  return {
    checks: [
      { target, options: { action: "stat files", ...(allowedType ? { allowedType } : {}) } },
    ],
    script: `set -eu\nif ! cd -- "$1" 2>/dev/null; then exit ${SANDBOX_STAT_PARENT_NOT_FOUND_EXIT_CODE}; fi\nstat -c "%F|%s|%y" -- "$2"`,
    args: [anchoredTarget.canonicalParentPath, anchoredTarget.basename],
    allowFailure: true,
  };
}
