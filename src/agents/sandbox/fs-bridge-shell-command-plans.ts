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

/** Builds a stat command that anchors the path at its canonical parent before reading metadata.
 *
 * Uses an explicit "ENOENT" sentinel (exit code 2) when the target or its
 * anchored parent directory does not exist, so callers can distinguish
 * "file not found" from other stat failures without relying on
 * locale-dependent stderr strings or the overly broad exit code 1. */
export function buildStatPlan(
  target: SandboxResolvedFsPath,
  anchoredTarget: AnchoredSandboxEntry,
): SandboxFsCommandPlan {
  return {
    checks: [{ target, options: { action: "stat files" } }],
    script: [
      "set -eu",
      "export LC_ALL=C",
      // Check parent exists before cd — stat(1) distinguishes ENOENT
      // ("No such file or directory") from EACCES ("Permission denied")
      // regardless of the shell's cd error format (bash vs dash).
      'err=$(stat -- "$1" 2>&1 >/dev/null) || {',
      '  case "$err" in *"No such file or directory") echo "ENOENT"; exit 2;; esac',
      '  echo "$err" >&2; exit 1',
      "}",
      // cd in main shell for correct canonical-parent anchoring.
      'cd -- "$1"',
      'out=$(stat -c "%F|%s|%y" -- "$2" 2>&1) && { echo "$out"; exit 0; }',
      // stat failed — classify via stderr (LC_ALL=C pins English).
      'case "$out" in *"No such file or directory") echo "ENOENT"; exit 2;; esac',
      // Not ENOENT — surface the captured error for diagnostics.
      'echo "$out" >&2; exit 1',
    ].join("\n"),
    args: [anchoredTarget.canonicalParentPath, anchoredTarget.basename],
    allowFailure: true,
  };
}
