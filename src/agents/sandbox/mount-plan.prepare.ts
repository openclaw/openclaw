import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { hasErrnoCode } from "../../infra/errno.js";
import { root as openFsSafeRoot } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { MATERIALIZED_SANDBOX_SKILLS_WORKSPACE } from "../../shared/sandbox-workspace-paths.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { translateSandboxMountSources, type InspectedSandboxMount } from "./docker-mount-source.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import { isPathInsideContainerRoot } from "./path-utils.js";
import type { SandboxWorkspaceAccess } from "./types.js";
import {
  normalizeMountContainerPath,
  resolveMaterializedSandboxSkillsWorkspaceDir,
  resolveProtectedMountAncestors,
  resolveSandboxMountSelection,
  resolveSandboxTmpfsMounts,
} from "./workspace-mounts.js";

export type SandboxMountPlan = {
  binds: string[];
  protectedTargets: string[];
  /** Writable self-binds pinning protected mounts' ancestors; upgrade-safe like protectedTargets. */
  pinnedAncestors?: readonly string[];
  skippedBinds: string[];
  readOnlyWorkspaceSkillMounts: ReturnType<
    typeof resolveSandboxMountSelection
  >["readOnlyWorkspaceSkillMounts"];
  tmpfs: ReturnType<typeof resolveSandboxTmpfsMounts>;
};

/** Returns whether the Gateway sees a managed directory through a read-only bind. */
function gatewaySourceIsReadOnly(
  namespace: readonly InspectedSandboxMount[],
  hostPath: string,
): boolean {
  // Ancestors may not exist yet; the covering bind of their nearest existing
  // parent is the one the engine would project.
  const source = resolveSandboxHostPathViaExistingAncestor(path.resolve(hostPath));
  const covering = namespace
    .filter((entry) => isPathInside(entry.destination, source))
    .toSorted((a, b) => b.destination.length - a.destination.length)[0];
  return covering !== undefined && !covering.writable;
}

export type SandboxMountPlanInput = {
  namespace?: readonly InspectedSandboxMount[];
  workspaceDir: string;
  workspaceSource?: "managed-worktree";
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  binds?: readonly string[];
  tmpfs?: readonly string[];
  readOnlyResourceMounts?: readonly { hostPath: string; containerPath: string }[];
};

export async function prepareSandboxMountPlanFilesystem(
  params: SandboxMountPlanInput,
  assertCurrent?: () => void,
): Promise<SandboxMountPlan> {
  const selection = resolveSandboxMountSelection(params);
  const namespace = params.namespace;
  const relativeSkillMount = `${MATERIALIZED_SANDBOX_SKILLS_WORKSPACE}/skills`;
  const skillTarget = normalizeMountContainerPath(`${params.workdir}/${relativeSkillMount}`);
  const managedSkillMount =
    params.workspaceSource === "managed-worktree" &&
    selection.readOnlyWorkspaceSkillMounts.some((mount) => mount.containerPath === skillTarget)
      ? path.join(params.workspaceDir, relativeSkillMount)
      : undefined;
  // A Gateway read-only bind under the workspace is already projected as its own
  // mountpoint (with its writable children intact), so it needs no extra pin.
  const ancestors = resolveProtectedMountAncestors(selection.mounts).filter(
    (ancestor) => !namespace || !gatewaySourceIsReadOnly(namespace, ancestor.hostPath),
  );
  for (const ancestor of ancestors) {
    // The managed scaffold below admits its whole ancestor chain once.
    if (managedSkillMount && isPathInside(ancestor.hostPath, managedSkillMount)) {
      continue;
    }
    // Bind sources must exist before create; engines would otherwise create them
    // root-owned (Docker) or refuse the bind (Podman). Symlinked ancestors fail closed.
    const owner = await openFsSafeRoot(ancestor.ownerHostPath, {
      mode: 0o755,
      mutationSymlinks: "reject",
      assertBeforeMutation: assertCurrent,
    });
    await owner.mkdir(ancestor.relativePath);
  }
  if (managedSkillMount) {
    // Engine-created nested mountpoints can be owned by a different user namespace.
    // Allocate the empty scaffold as its workspace owner before mounting read-only
    // instructions, so normal workspace retention can later remove it without chmod.
    try {
      const workspace = await openFsSafeRoot(params.workspaceDir, {
        mode: 0o755,
        mutationSymlinks: "reject",
        assertBeforeMutation: assertCurrent,
      });
      await workspace.mkdir(relativeSkillMount);
    } catch (error) {
      // Older fs-safe versions wrap traversal denials as path-alias failures.
      const permissionError = collectNestedErrorCandidates(error).find(
        (candidate) => hasErrnoCode(candidate, "EACCES") || hasErrnoCode(candidate, "EPERM"),
      );
      if (!permissionError) {
        throw error;
      }
      const target = path.join(params.workspaceDir, relativeSkillMount);
      throw new Error(
        `Cannot prepare sandbox skills mountpoint "${target}": permission denied. ` +
          "Fix ownership or ACLs on the existing directory and its parents so the gateway user " +
          "has search (execute) and write access, then retry.",
        { cause: error },
      );
    }
  }
  const ancestorsByProtectedTarget = new Map(
    selection.mounts
      .filter((mount) => mount.source === "protectedSkill")
      .map((mount) => {
        const target = normalizeMountContainerPath(mount.containerPath);
        return [
          target,
          ancestors.filter((ancestor) => isPathInsideContainerRoot(ancestor.containerPath, target)),
        ] as const;
      }),
  );
  const allowedRoots = [
    params.workspaceDir,
    params.agentWorkspaceDir,
    params.skillsWorkspaceDir ??
      resolveMaterializedSandboxSkillsWorkspaceDir(params.agentWorkspaceDir),
    ...(params.readOnlyResourceMounts ?? []).map((mount) => mount.hostPath),
  ];
  const targets = [
    ...selection.mounts.map((mount) => mount.containerPath),
    ...ancestors.map((ancestor) => ancestor.containerPath),
  ];
  const binds = new Map<string, string>();
  const planned: Array<(typeof selection.mounts)[number]> = [];
  const protectedTargets = new Set<string>();
  const pinnedAncestors = new Set<string>();
  const pinnedAncestorTargets = new Set(
    ancestors.map((ancestor) => normalizeMountContainerPath(ancestor.containerPath)),
  );
  for (const mount of selection.mounts) {
    // Keep each self-bind ancestor directly before the first protected mount it pins.
    for (const ancestor of ancestorsByProtectedTarget.get(
      normalizeMountContainerPath(mount.containerPath),
    ) ?? []) {
      if (!planned.includes(ancestor)) {
        planned.push(ancestor);
      }
    }
    planned.push(mount);
  }
  for (const mount of planned) {
    const target = normalizeMountContainerPath(mount.containerPath);
    if (mount.source === "bind") {
      continue;
    }
    const translated = namespace
      ? translateSandboxMountSources({
          source: mount.hostPath,
          containerPath: target,
          allowedRoots,
          mounts: namespace,
          readOnly: mount.readOnly,
          shadowedTargets: targets.filter(
            (other) => other !== target && isPathInside(target, other),
          ),
        })
      : [{ ...mount, containerPath: target }];
    for (const projected of translated) {
      if (mount.source === "protectedSkill") {
        protectedTargets.add(projected.containerPath);
      }
      if (pinnedAncestorTargets.has(target)) {
        pinnedAncestors.add(projected.containerPath);
      }
      binds.set(
        projected.containerPath,
        `${projected.hostPath}:${projected.containerPath}:${projected.readOnly ? "ro,z" : "z"}`,
      );
    }
  }
  // Custom mounts retain their daemon-host contract. Protected instruction mounts
  // win exact collisions; other explicit overrides match filesystem bridge policy.
  for (const bind of selection.custom) {
    const parsed = splitSandboxBindSpec(bind);
    const target = parsed ? normalizeMountContainerPath(parsed.container) : bind;
    binds.set(target, bind);
    protectedTargets.delete(target);
  }
  return {
    binds: [...binds.values()],
    protectedTargets: [...protectedTargets],
    pinnedAncestors: [...pinnedAncestors],
    skippedBinds: selection.skippedBinds,
    readOnlyWorkspaceSkillMounts: selection.readOnlyWorkspaceSkillMounts,
    tmpfs: resolveSandboxTmpfsMounts(params.tmpfs),
  };
}
