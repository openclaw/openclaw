import type { SandboxWorkspaceAccess } from "./types.js";

export function isManagedWorkspaceWritable(access: SandboxWorkspaceAccess): boolean {
  return access !== "ro";
}

export function isSandboxWriteAccessEnabled(access: SandboxWorkspaceAccess): boolean {
  return isManagedWorkspaceWritable(access);
}

export function shouldMountAgentWorkspace(access: SandboxWorkspaceAccess): boolean {
  return access !== "none";
}

export function isAgentWorkspaceWritable(access: SandboxWorkspaceAccess): boolean {
  return access === "rw";
}
