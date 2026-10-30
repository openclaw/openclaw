import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
export type WorkspaceFileMode = AgentDefaults["workspaceFileMode"];

export function resolveWorkspaceCreationMode(configured: WorkspaceFileMode): number {
  // fs-safe enforces an exact mode. Snapshot this host's umask before any awaited I/O.
  return configured === undefined
    ? 0o600
    : Number.parseInt(configured, 8) & ~process.umask() & 0o666;
}
