import fs from "node:fs";
import path from "node:path";
import { isNotFoundPathError } from "@openclaw/fs-safe/path";
import { hasErrnoCode } from "../../infra/errno.js";
import { findExistingAncestor, root as createWorkspaceRoot } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS } from "../../shared/sandbox-workspace-paths.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import { normalizeContainerPathCore } from "./path-utils.js";
import type { SandboxWorkspaceAccess } from "./types.js";

export const SANDBOX_MOUNT_FORMAT_VERSION = 4;

/** Managed skill directory projected read-only into the sandbox workspace. */
export type ReadOnlyWorkspaceSkillMount = {
  hostPath: string;
  containerPath: string;
};

type WorkspaceSkillMountParams = {
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
};

function containerJoin(root: string, ...parts: string[]): string {
  const normalizedRoot = root.endsWith("/") && root !== "/" ? root.slice(0, -1) : root;
  const suffix = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot;
}

export function normalizeMountContainerPath(containerPath: string): string {
  return normalizeContainerPathCore(containerPath).replace(/\/+$/, "") || "/";
}

/** Hidden workspace used to materialize non-workspace skills for rw sandboxes. */
export function resolveMaterializedSandboxSkillsWorkspaceDir(rootDir: string): string {
  return path.join(rootDir, ...MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS);
}

/** Returns true when a skill mount source exists inside the canonical mount root. */
function isExistingWorkspaceSkillMountSource(params: {
  rootDir: string;
  hostPath: string;
}): boolean {
  try {
    if (!fs.lstatSync(params.hostPath).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  const agentRoot = resolveSandboxHostPathViaExistingAncestor(path.resolve(params.rootDir));
  const canonicalSource = resolveSandboxHostPathViaExistingAncestor(path.resolve(params.hostPath));
  return isPathInside(agentRoot, canonicalSource);
}

/** Protects managed skills inside writable shared or private sandbox workspaces. */
function resolveReadOnlyWorkspaceSkillMountCandidates(params: WorkspaceSkillMountParams) {
  if (params.workspaceAccess === "ro") {
    return [];
  }

  // Private workspaces protect their own synced instructions, never mount the
  // shared agent workspace merely to obtain its skill sources.
  const rootDir =
    params.workspaceAccess === "none" ? params.workspaceDir : params.agentWorkspaceDir;
  const mounts = [
    {
      hostPath: path.join(rootDir, "skills"),
      containerPath: containerJoin(params.workdir, "skills"),
      rootDir,
    },
    {
      hostPath: path.join(rootDir, ".agents", "skills"),
      containerPath: containerJoin(params.workdir, ".agents", "skills"),
      rootDir,
    },
  ];
  if (params.workspaceAccess === "rw") {
    const materializedSkillsWorkspaceDir =
      params.skillsWorkspaceDir ?? resolveMaterializedSandboxSkillsWorkspaceDir(rootDir);
    mounts.push({
      hostPath: path.join(materializedSkillsWorkspaceDir, "skills"),
      containerPath: containerJoin(
        params.workdir,
        ...MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS,
        "skills",
      ),
      rootDir: materializedSkillsWorkspaceDir,
    });
  }

  return mounts;
}

/** Materialize protected sources before selecting the first sandbox's mounts. */
export async function ensureReadOnlyWorkspaceSkillMountSources(
  params: WorkspaceSkillMountParams,
  assertCurrent?: () => void,
): Promise<void> {
  for (const mount of resolveReadOnlyWorkspaceSkillMountCandidates(params)) {
    const canonicalRoot = resolveSandboxHostPathViaExistingAncestor(path.resolve(mount.rootDir));
    const canonicalSource = resolveSandboxHostPathViaExistingAncestor(path.resolve(mount.hostPath));
    if (!isPathInside(canonicalRoot, canonicalSource)) {
      continue;
    }
    try {
      fs.lstatSync(mount.hostPath);
      continue;
    } catch (error) {
      if (hasErrnoCode(error, "ENOTDIR")) {
        continue;
      }
      if (!isNotFoundPathError(error)) {
        throw error;
      }
    }
    const ancestor = await findExistingAncestor(canonicalSource);
    if (!ancestor || !fs.lstatSync(ancestor).isDirectory()) {
      continue;
    }
    // Create through the canonical source, with custody and alias checks at every
    // mkdir, so a replaced workspace parent cannot redirect host preparation.
    const directory = await createWorkspaceRoot(ancestor, {
      mutationSymlinks: "reject",
      assertBeforeMutation: () => {
        assertCurrent?.();
        if (
          resolveSandboxHostPathViaExistingAncestor(path.resolve(mount.rootDir)) !==
            canonicalRoot ||
          resolveSandboxHostPathViaExistingAncestor(path.resolve(mount.hostPath)) !==
            canonicalSource
        ) {
          throw new Error(
            `Sandbox skill mount source changed during preparation: ${mount.hostPath}`,
          );
        }
      },
    });
    await directory.mkdir(path.relative(ancestor, canonicalSource));
    assertCurrent?.();
  }
}

export function resolveReadOnlyWorkspaceSkillMounts(
  params: WorkspaceSkillMountParams,
): ReadOnlyWorkspaceSkillMount[] {
  return resolveReadOnlyWorkspaceSkillMountCandidates(params)
    .filter(isExistingWorkspaceSkillMountSource)
    .map(({ hostPath, containerPath }) => ({ hostPath, containerPath }));
}

export type ManagedWorkspaceMount = ReadOnlyWorkspaceSkillMount & { readOnly: boolean };
export type SandboxSelectedMount = ManagedWorkspaceMount & {
  source: "workspace" | "agent" | "bind" | "protectedSkill";
};

/** Resolves Gateway-local sources before the container lifecycle selects daemon paths. */
export function resolveWorkspaceMounts(params: {
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  readOnlyWorkspaceSkillMounts?: readonly ReadOnlyWorkspaceSkillMount[];
}): SandboxSelectedMount[] {
  const { workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;
  const mounts: SandboxSelectedMount[] = [
    {
      hostPath: workspaceDir,
      containerPath: workdir,
      readOnly: workspaceAccess === "ro",
      source: "workspace",
    },
  ];

  if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) {
    mounts.push({
      hostPath: agentWorkspaceDir,
      containerPath: SANDBOX_AGENT_WORKSPACE_MOUNT,
      readOnly: workspaceAccess === "ro",
      source: "agent",
    });
  }

  const skills = params.readOnlyWorkspaceSkillMounts ?? resolveReadOnlyWorkspaceSkillMounts(params);
  for (const { hostPath, containerPath } of skills) {
    mounts.push({ hostPath, containerPath, readOnly: true, source: "protectedSkill" });
  }
  return mounts;
}

/** Select exact-target winners without rewriting the operator's daemon-host bind strings. */
function selectSandboxBindMounts(binds: readonly string[] | undefined): string[] {
  const selected = new Map<string, string>();
  for (const bind of binds ?? []) {
    const parsed = splitSandboxBindSpec(bind);
    // Unparsed entries still reach validation/the engine; dropping one would
    // silently turn an invalid mount request into a different filesystem.
    selected.set(parsed ? normalizeMountContainerPath(parsed.container) : bind, bind);
  }
  return [...selected.values()];
}

export function resolveSandboxBindMounts(
  binds: readonly string[] | undefined,
): SandboxSelectedMount[] {
  return selectSandboxBindMounts(binds).flatMap((bind) => {
    const parsed = splitSandboxBindSpec(bind);
    if (!parsed?.host || !path.posix.isAbsolute(parsed.container)) {
      return [];
    }
    return [
      {
        hostPath: parsed.host,
        containerPath: normalizeMountContainerPath(parsed.container),
        readOnly: parsed.options
          .toLowerCase()
          .split(",")
          .some((option) => option.trim() === "ro"),
        source: "bind" as const,
      },
    ];
  });
}

/** One selection owns container creation, file projection, and file-tool permissions. */
export function resolveSandboxMountSelection(
  params: Parameters<typeof resolveWorkspaceMounts>[0] & {
    binds?: readonly string[];
    readOnlyResourceMounts?: readonly ReadOnlyWorkspaceSkillMount[];
  },
) {
  const readOnlyWorkspaceSkillMounts = resolveReadOnlyWorkspaceSkillMounts(params);
  const managed = resolveWorkspaceMounts({ ...params, readOnlyWorkspaceSkillMounts });
  const resources = params.readOnlyResourceMounts ?? [];
  const protectedTargets = new Set(
    [...readOnlyWorkspaceSkillMounts, ...resources].map((mount) =>
      normalizeMountContainerPath(mount.containerPath),
    ),
  );
  // Keep one authoritative read-only instruction mount at each protected target.
  // Unparsed binds still reach validation/the engine instead of silently disappearing.
  const allowed = (params.binds ?? []).filter((bind) => {
    const spec = splitSandboxBindSpec(bind);
    return !spec || !protectedTargets.has(normalizeMountContainerPath(spec.container));
  });
  const custom = selectSandboxBindMounts(allowed);
  const mounts = new Map<string, SandboxSelectedMount>();
  for (const mount of managed) {
    const containerPath = normalizeMountContainerPath(mount.containerPath);
    mounts.set(containerPath, { ...mount, containerPath });
  }
  for (const mount of resolveSandboxBindMounts(custom)) {
    mounts.set(mount.containerPath, mount);
  }
  for (const resource of resources) {
    const containerPath = normalizeMountContainerPath(resource.containerPath);
    mounts.set(containerPath, {
      hostPath: resource.hostPath,
      containerPath,
      readOnly: true,
      source: "protectedSkill",
    });
  }
  return {
    mounts: [...mounts.values()],
    custom,
    skippedBinds: (params.binds ?? []).filter((bind) => !allowed.includes(bind)),
    readOnlyWorkspaceSkillMounts,
  };
}

/** Writable self-bind keeping one directory between a managed root and a protected mount in place. */
export type ProtectedMountAncestor = SandboxSelectedMount & {
  /** Local root of the managed mount that owns this directory. */
  ownerHostPath: string;
  /** Path of the directory relative to ownerHostPath. */
  relativePath: string;
};

/**
 * Linux refuses to rename a mountpoint but not one of its ancestors. Binding each
 * writable directory between a managed root and a nested protected mount onto
 * itself makes those ancestors mountpoints too, so a sandboxed process cannot
 * move the protected mount aside and recreate its pathname as ordinary files.
 */
export function resolveProtectedMountAncestors(
  mounts: readonly SandboxSelectedMount[],
): ProtectedMountAncestor[] {
  const byTarget = new Map(
    mounts.map((mount) => [normalizeMountContainerPath(mount.containerPath), mount] as const),
  );
  const ancestors = new Map<string, ProtectedMountAncestor>();
  for (const mount of mounts) {
    if (mount.source !== "protectedSkill") {
      continue;
    }
    const chain: string[] = [];
    let owner: SandboxSelectedMount | undefined;
    let ownerTarget = "/";
    for (
      let current = path.posix.dirname(normalizeMountContainerPath(mount.containerPath));
      ;
      current = path.posix.dirname(current)
    ) {
      owner = byTarget.get(current);
      if (owner || current === "/") {
        ownerTarget = current;
        break;
      }
      chain.push(current);
    }
    // Only managed writable roots have Gateway-local sources we can pin; read-only
    // roots already refuse the rename and custom binds keep their daemon contract.
    if (!owner || owner.readOnly || (owner.source !== "workspace" && owner.source !== "agent")) {
      continue;
    }
    for (const ancestor of chain) {
      if (ancestors.has(ancestor)) {
        continue;
      }
      const relativePath = path.posix.relative(ownerTarget, ancestor);
      ancestors.set(ancestor, {
        hostPath: path.join(owner.hostPath, ...relativePath.split("/")),
        containerPath: ancestor,
        readOnly: false,
        source: owner.source,
        ownerHostPath: owner.hostPath,
        relativePath,
      });
    }
  }
  // Parents first so engine creation order matches the directory hierarchy.
  return [...ancestors.values()].toSorted(
    (a, b) => a.containerPath.length - b.containerPath.length,
  );
}

/** Docker keeps the final ro/rw flag; Podman rejects conflicting flags before creation. */
export function sandboxMountOptionsReadOnly(options: string): boolean {
  let readOnly = false;
  for (const option of options.split(",")) {
    if (option === "ro" || option === "rw") {
      readOnly = option === "ro";
    }
  }
  return readOnly;
}

export function resolveSandboxTmpfsMounts(tmpfs: readonly string[] | undefined) {
  const mounts = new Map<string, { containerPath: string; readOnly: boolean }>();
  for (const spec of tmpfs ?? []) {
    const separator = spec.indexOf(":");
    const target = separator === -1 ? spec : spec.slice(0, separator);
    const options = separator === -1 ? "" : spec.slice(separator + 1);
    const containerPath = normalizeMountContainerPath(target);
    mounts.set(containerPath, { containerPath, readOnly: sandboxMountOptionsReadOnly(options) });
  }
  return [...mounts.values()];
}
