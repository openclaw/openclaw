import { PATH_ALIAS_POLICIES } from "../../infra/path-alias-guards.js";
import { SANDBOX_PINNED_FS_MUTATION_PYTHON } from "./fs-bridge-mutation-python-source.js";
import type { PinnedSandboxEntry } from "./fs-bridge-path-safety.js";
import type { SandboxFsCommandPlan } from "./fs-bridge-shell-command-plans.js";
import type { SandboxResolvedFsPath } from "./fs-paths.js";

function buildPinnedMutationPlan(params: {
  checks: SandboxFsCommandPlan["checks"];
  args: string[];
  stdin?: Buffer | string;
}): SandboxFsCommandPlan {
  return {
    checks: params.checks,
    recheckBeforeCommand: true,
    script: ["set -eu", "python3 - \"$@\" <<'PY'", SANDBOX_PINNED_FS_MUTATION_PYTHON, "PY"].join(
      "\n",
    ),
    args: params.args,
    stdin: params.stdin,
  };
}

export function buildPinnedWritePlan(params: {
  target: SandboxResolvedFsPath;
  pinned: PinnedSandboxEntry;
  mkdir: boolean;
  stdin: Buffer | string;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
    checks: [
      {
        target: params.target,
        options: { action: "write files", requireWritable: true },
      },
    ],
    args: [
      "write",
      params.pinned.mountRootPath,
      params.pinned.relativeParentPath,
      params.pinned.basename,
      params.mkdir ? "1" : "0",
    ],
    stdin: params.stdin,
  });
}

export function buildPinnedMkdirpPlan(params: {
  target: SandboxResolvedFsPath;
  pinned: PinnedSandboxEntry;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
    checks: [
      {
        target: params.target,
        options: {
          action: "create directories",
          requireWritable: true,
          allowedType: "directory",
        },
      },
    ],
    args: [
      "mkdirp",
      params.pinned.mountRootPath,
      params.pinned.relativeParentPath,
      params.pinned.basename,
    ],
  });
}

export function buildPinnedRemovePlan(params: {
  target: SandboxResolvedFsPath;
  pinned: PinnedSandboxEntry;
  recursive?: boolean;
  force?: boolean;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
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
    args: [
      "remove",
      params.pinned.mountRootPath,
      params.pinned.relativeParentPath,
      params.pinned.basename,
      params.recursive ? "1" : "0",
      params.force === false ? "0" : "1",
    ],
  });
}

export function buildPinnedRenamePlan(params: {
  from: SandboxResolvedFsPath;
  to: SandboxResolvedFsPath;
  pinnedFrom: PinnedSandboxEntry;
  pinnedTo: PinnedSandboxEntry;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
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
    args: [
      "rename",
      params.pinnedFrom.mountRootPath,
      params.pinnedFrom.relativeParentPath,
      params.pinnedFrom.basename,
      params.pinnedTo.mountRootPath,
      params.pinnedTo.relativeParentPath,
      params.pinnedTo.basename,
    ],
  });
}

export { SANDBOX_PINNED_FS_MUTATION_PYTHON };
