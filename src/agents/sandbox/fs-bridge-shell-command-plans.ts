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
 * Locale-independent stdout marker for a missing anchored basename.
 * Prefer this over parsing localized `stat` stderr (e.g. "No such file or directory").
 */
export const SANDBOX_STAT_MISSING_MARKER = "__OPENCLAW_SANDBOX_STAT_MISSING__";

/** Builds a stat command that anchors the path at its canonical parent before reading metadata. */
export function buildStatPlan(
  target: SandboxResolvedFsPath,
  anchoredTarget: AnchoredSandboxEntry,
): SandboxFsCommandPlan {
  // Run `stat` first so dangling symlink entries keep GNU metadata. Only after a
  // failed stat, classify genuine absence with both `-e` and `-L` and emit a
  // reserved marker (locale-independent; no check-then-use race on the basename).
  const script = [
    "set -eu",
    'cd -- "$1"',
    'if ! stat -c "%F|%s|%y" -- "$2"; then',
    '  if [ ! -e "$2" ] && [ ! -L "$2" ]; then',
    `    printf '%s\\n' '${SANDBOX_STAT_MISSING_MARKER}'`,
    "    exit 0",
    "  fi",
    "  exit 1",
    "fi",
  ].join("\n");
  return {
    checks: [{ target, options: { action: "stat files" } }],
    script,
    args: [anchoredTarget.canonicalParentPath, anchoredTarget.basename],
    allowFailure: true,
  };
}
