/**
 * Shell command plans for sandbox filesystem bridge operations.
 *
 * Plans carry path-safety checks alongside the command so rechecks and execution stay coupled.
 */
import type {
  AnchoredSandboxEntry,
  PathSafetyCheck,
  PinnedSandboxDirectoryEntry,
} from "./fs-bridge-path-safety.js";
import type { SandboxResolvedFsPath } from "./fs-paths.js";

export type SandboxFsCommandPlan = {
  checks: PathSafetyCheck[];
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  recheckBeforeCommand?: boolean;
  allowFailure?: boolean;
};

/** Builds a stat command that anchors the path at its canonical parent before reading metadata. */
export function buildStatPlan(
  target: SandboxResolvedFsPath,
  anchoredTarget: AnchoredSandboxEntry,
): SandboxFsCommandPlan {
  return {
    checks: [{ target, options: { action: "stat files" } }],
    script: 'set -eu\ncd -- "$1"\nstat -c "%F|%s|%y" -- "$2"',
    args: [anchoredTarget.canonicalParentPath, anchoredTarget.basename],
    allowFailure: true,
  };
}

/** Builds a directory listing command anchored at the path's canonical parent. */
export function buildReaddirPlan(
  target: SandboxResolvedFsPath,
  pinnedTarget: PinnedSandboxDirectoryEntry,
): SandboxFsCommandPlan {
  return {
    checks: [{ target, options: { action: "list directories", allowedType: "directory" } }],
    script: [
      "set -eu",
      'cd -- "$1"',
      "python3 - \"$2\" <<'PY'",
      "import json, os, sys",
      "target = sys.argv[1] or '.'",
      "print(json.dumps(os.listdir(target)))",
      "PY",
    ].join("\n"),
    args: [pinnedTarget.mountRootPath, pinnedTarget.relativePath],
    allowFailure: true,
  };
}
