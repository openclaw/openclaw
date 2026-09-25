/**
 * Sandbox workspace mount argument builder.
 *
 * Creates Docker bind specs for writable workspaces and read-only skill source mounts.
 */
import fs from "node:fs";
import path from "node:path";
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
export function resolveReadOnlyWorkspaceSkillMounts(params: {
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
}): ReadOnlyWorkspaceSkillMount[] {
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

  return mounts
    .filter((mount) =>
      isExistingWorkspaceSkillMountSource({
        rootDir: mount.rootDir,
        hostPath: mount.hostPath,
      }),
    )
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
