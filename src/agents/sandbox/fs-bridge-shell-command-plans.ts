import type { AnchoredSandboxEntry, PathSafetyCheck } from "./fs-bridge-path-safety.js";
import type { SandboxResolvedFsPath } from "./fs-paths.js";
import { PATH_ALIAS_POLICIES } from "../../infra/path-alias-guards.js";

export type SandboxFsCommandPlan = {
  checks: PathSafetyCheck[];
  script: string;
  args?: string[];
  recheckBeforeCommand?: boolean;
  allowFailure?: boolean;
};

export function buildWriteCommitPlan(
  target: SandboxResolvedFsPath,
  tempPath: string,
): SandboxFsCommandPlan {
  return {
    checks: [{ target, options: { action: "write files", requireWritable: true } }],
    recheckBeforeCommand: true,
    script: 'set -eu; mv -f -- "$1" "$2"',
    args: [tempPath, target.containerPath],
  };
}

export function buildMkdirpPlan(
  target: SandboxResolvedFsPath,
  anchoredTarget: AnchoredSandboxEntry,
): SandboxFsCommandPlan {
  return {
    checks: [
      {
        target,
        options: {
          action: "create directories",
          requireWritable: true,
          allowedType: "directory",
        },
      },
    ],
    script: 'set -eu\ncd -- "$1"\nmkdir -p -- "$2"',
    args: [anchoredTarget.canonicalParentPath, anchoredTarget.basename],
  };
}

export function buildRemovePlan(params: {
  target: SandboxResolvedFsPath;
  anchoredTarget: AnchoredSandboxEntry;
  recursive?: boolean;
  force?: boolean;
}): SandboxFsCommandPlan {
  const flags = [params.force === false ? "" : "-f", params.recursive ? "-r" : ""].filter(Boolean);
  const rmCommand = flags.length > 0 ? `rm ${flags.join(" ")}` : "rm";
  return {
    checks: [
      {
        target: params.target,
        options: {
          action: "remove files",
          requireWritable: true,
          aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget,
        },
      },
    ],
    recheckBeforeCommand: true,
    script: `set -eu\ncd -- "$1"\n${rmCommand} -- "$2"`,
    args: [params.anchoredTarget.canonicalParentPath, params.anchoredTarget.basename],
  };
}

export function buildRenamePlan(params: {
  from: SandboxResolvedFsPath;
  to: SandboxResolvedFsPath;
  anchoredFrom: AnchoredSandboxEntry;
  anchoredTo: AnchoredSandboxEntry;
}): SandboxFsCommandPlan {
  return {
    checks: [
      {
        target: params.from,
        options: {
          action: "rename files",
          requireWritable: true,
          aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget,
        },
      },
      {
        target: params.to,
        options: {
          action: "rename files",
          requireWritable: true,
        },
      },
    ],
    recheckBeforeCommand: true,
    script: ["set -eu", 'mkdir -p -- "$2"', 'cd -- "$1"', 'mv -- "$3" "$2/$4"'].join("\n"),
    args: [
      params.anchoredFrom.canonicalParentPath,
      params.anchoredTo.canonicalParentPath,
      params.anchoredFrom.basename,
      params.anchoredTo.basename,
    ],
  };
}

export function buildStatPlan(target: SandboxResolvedFsPath): SandboxFsCommandPlan {
  return {
    checks: [{ target, options: { action: "stat files" } }],
    script: 'set -eu; stat -c "%F|%s|%Y" -- "$1"',
    args: [target.containerPath],
    allowFailure: true,
  };
}
