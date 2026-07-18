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

export const SANDBOX_STAT_MISSING_SENTINEL = "__OPENCLAW_STAT_MISSING__";
export const SANDBOX_STAT_METADATA_FORMAT = "%f|%s|%.Y";

/** Builds a stat command that anchors the path at its canonical parent before reading metadata. */
export function buildStatPlan(
  target: SandboxResolvedFsPath,
  anchoredTarget: AnchoredSandboxEntry,
): SandboxFsCommandPlan {
  return {
    checks: [{ target, options: { action: "stat files" } }],
    script: [
      "set -eu",
      'if ! cd -- "$1"; then',
      '  if [ ! -e "$1" ] && [ ! -L "$1" ]; then',
      `    printf "${SANDBOX_STAT_MISSING_SENTINEL}\\n"`,
      "    exit 0",
      "  fi",
      "  exit 1",
      "fi",
      'if [ ! -e "$2" ] && [ ! -L "$2" ]; then',
      `  printf "${SANDBOX_STAT_MISSING_SENTINEL}\\n"`,
      "  exit 0",
      "fi",
      `if stat_output=$(stat -c '${SANDBOX_STAT_METADATA_FORMAT}' -- "$2" 2>&1); then`,
      '  printf "%s\\n" "$stat_output"',
      "  exit 0",
      "else",
      "  stat_status=$?",
      "fi",
      'if [ ! -e "$2" ] && [ ! -L "$2" ]; then',
      `  printf "${SANDBOX_STAT_MISSING_SENTINEL}\\n"`,
      "  exit 0",
      "fi",
      'printf "%s\\n" "$stat_output" >&2',
      'exit "$stat_status"',
    ].join("\n"),
    args: [anchoredTarget.canonicalParentPath, anchoredTarget.basename],
    allowFailure: true,
  };
}
