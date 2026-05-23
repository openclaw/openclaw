import fs from "node:fs";
import path from "node:path";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import type { SandboxWorkspaceAccess } from "./types.js";

export const SANDBOX_MOUNT_FORMAT_VERSION = 3;

export type ReadOnlyWorkspaceSkillMount = {
  hostPath: string;
  containerPath: string;
};

function formatManagedWorkspaceBind(params: {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}): string {
  return `${params.hostPath}:${params.containerPath}:${params.readOnly ? "ro,z" : "z"}`;
}

function containerJoin(root: string, ...parts: string[]): string {
  const normalizedRoot = root.endsWith("/") && root !== "/" ? root.slice(0, -1) : root;
  const suffix = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot;
}

function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function resolveReadOnlyWorkspaceSkillMounts(params: {
  workspaceDir: string;
  agentWorkspaceDir: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
}): ReadOnlyWorkspaceSkillMount[] {
  if (params.workspaceAccess !== "rw") {
    return [];
  }

  const mounts = [
    {
      hostPath: path.join(params.agentWorkspaceDir, "skills"),
      containerPath: containerJoin(params.workdir, "skills"),
    },
    {
      hostPath: path.join(params.agentWorkspaceDir, ".agents", "skills"),
      containerPath: containerJoin(params.workdir, ".agents", "skills"),
    },
  ];

  return mounts.filter((mount) => isExistingDirectory(mount.hostPath));
}

export function formatReadOnlyWorkspaceSkillMountHashState(
  mounts: readonly ReadOnlyWorkspaceSkillMount[],
): string[] {
  return mounts.map((mount) => `${mount.hostPath}:${mount.containerPath}:ro`);
}

function appendReadOnlyWorkspaceSkillMounts(params: {
  args: string[];
  readOnlyWorkspaceSkillMounts: readonly ReadOnlyWorkspaceSkillMount[];
}): void {
  for (const mount of params.readOnlyWorkspaceSkillMounts) {
    params.args.push(
      "-v",
      formatManagedWorkspaceBind({
        hostPath: mount.hostPath,
        containerPath: mount.containerPath,
        readOnly: true,
      }),
    );
  }
}

export function appendWorkspaceMountArgs(params: {
  args: string[];
  workspaceDir: string;
  agentWorkspaceDir: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  readOnlyWorkspaceSkillMounts?: readonly ReadOnlyWorkspaceSkillMount[];
}) {
  const { args, workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;

  args.push(
    "-v",
    formatManagedWorkspaceBind({
      hostPath: workspaceDir,
      containerPath: workdir,
      readOnly: workspaceAccess !== "rw",
    }),
  );

  if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) {
    args.push(
      "-v",
      formatManagedWorkspaceBind({
        hostPath: agentWorkspaceDir,
        containerPath: SANDBOX_AGENT_WORKSPACE_MOUNT,
        readOnly: workspaceAccess === "ro",
      }),
    );
  }

  appendReadOnlyWorkspaceSkillMounts({
    args,
    readOnlyWorkspaceSkillMounts:
      params.readOnlyWorkspaceSkillMounts ??
      resolveReadOnlyWorkspaceSkillMounts({
        workspaceDir,
        agentWorkspaceDir,
        workdir,
        workspaceAccess,
      }),
  });
}
