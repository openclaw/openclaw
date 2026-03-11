import type { PathSafetyCheck } from "./fs-bridge-path-safety.js";
import type { SandboxResolvedFsPath } from "./fs-paths.js";

export type SandboxFsCommandPlan = {
  checks: PathSafetyCheck[];
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  recheckBeforeCommand?: boolean;
  allowFailure?: boolean;
};

export function buildStatPlan(target: SandboxResolvedFsPath): SandboxFsCommandPlan {
  return {
    checks: [{ target, options: { action: "stat files" } }],
    script: 'set -eu; stat -c "%F|%s|%Y" -- "$1"',
    args: [target.containerPath],
    allowFailure: true,
  };
}
