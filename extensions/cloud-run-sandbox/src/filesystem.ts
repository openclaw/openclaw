import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveReadOnlyWorkspaceSkillMounts,
  type CreateReservedSandboxBackendParamsV1,
} from "openclaw/plugin-sdk/sandbox";

export type Mount = { hostPath: string; containerPath: string; readOnly: boolean };
const within = (root: string, target: string) =>
  root === "/" || target === root || target.startsWith(root + "/");
export async function validateRootfs(rootfs: string, stateDir: string): Promise<string> {
  const root = await fs.realpath(rootfs);
  const state = await fs.realpath(stateDir);
  if (root === "/" || within(root, state) || within(state, root)) {
    throw new Error("Cloud Run rootfs must be separate from the Gateway filesystem and state");
  }
  // A guest must never be able to replace the clean image root between launches.
  for (let current = root; ; current = path.dirname(current)) {
    const stat = await fs.stat(current);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error(
        "Cloud Run rootfs and its parents must be root-owned directories, not group/world writable",
      );
    }
    if (current === "/") {
      break;
    }
  }
  for (const required of ["bin/sh", "bin/sleep", "usr/bin/env"]) {
    await fs.access(path.join(root, required), fs.constants.X_OK);
  }
  return root;
}

export async function resolveMounts(
  params: CreateReservedSandboxBackendParamsV1,
  rootfs: string,
): Promise<Mount[]> {
  if (params.workspaceSource || params.cfg.docker.binds?.length || params.cfg.docker.setupCommand) {
    throw new Error(
      "Cloud Run sandbox does not support managed worktrees, Docker binds, or setupCommand",
    );
  }
  const mounts: Mount[] = [
    {
      hostPath: params.workspaceDir,
      containerPath: "/workspace",
      readOnly: params.cfg.workspaceAccess === "ro",
    },
  ];
  if (params.cfg.workspaceAccess !== "none" && params.workspaceDir !== params.agentWorkspaceDir) {
    mounts.push({
      hostPath: params.agentWorkspaceDir,
      containerPath: "/agent",
      readOnly: params.cfg.workspaceAccess === "ro",
    });
  }
  for (const mount of [
    ...resolveReadOnlyWorkspaceSkillMounts({
      ...params,
      workdir: "/workspace",
      workspaceAccess: params.cfg.workspaceAccess,
    }),
    ...(params.readOnlyResourceMounts ?? []),
  ]) {
    mounts.push({ ...mount, readOnly: true });
  }
  const selected = new Map<string, Mount>();
  for (const mount of mounts) {
    const hostPath = await fs.realpath(mount.hostPath);
    const containerPath = path.posix.normalize(mount.containerPath);
    if (
      /[\0,\r\n]/.test(hostPath) ||
      /[\0,\r\n]/.test(containerPath) ||
      !["/workspace", "/agent"].some((root) => within(root, containerPath))
    ) {
      throw new Error("Cloud Run mount cannot be represented safely");
    }
    if (within(hostPath, rootfs) || within(rootfs, hostPath)) {
      throw new Error("Cloud Run workspace must not overlap the clean rootfs");
    }
    selected.set(containerPath, { ...mount, hostPath, containerPath });
  }
  const resolved = [...selected.values()];
  for (const [index, mount] of resolved.entries()) {
    for (const other of resolved.slice(index + 1)) {
      if (
        (!mount.readOnly || !other.readOnly) &&
        (within(mount.hostPath, other.hostPath) || within(other.hostPath, mount.hostPath))
      ) {
        // Another writable view could replace this source before a later launch
        // or modify a readonly resource through an uncovered alias. A pathname
        // recheck cannot pin that filesystem identity.
        throw new Error(
          "Cloud Run sandbox requires disjoint host mount sources when either is writable; nested skill/resource sources need a provider-supported pinned mount owner",
        );
      }
    }
  }
  params.assertRuntimeCurrent();
  return resolved;
}
