/** Pure mount and path helpers for the remote sandbox filesystem bridge. */
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { isPathInsideContainerRoot, normalizeContainerPathCore } from "./path-utils.js";

export type RemoteMountSource = "workspace" | "agent" | "protectedSkill";

export type RemoteMountInfo = {
  localRoot: string;
  containerRoot: string;
  writable: boolean;
  source: RemoteMountSource;
};

const MOUNT_SOURCE_PRIORITY = { workspace: 0, agent: 1, protectedSkill: 2 };

export function resolveRemoteMountByContainerPath(
  mounts: RemoteMountInfo[],
  containerPath: string,
): RemoteMountInfo | null {
  return (
    mounts
      .toSorted(
        (a, b) =>
          b.containerRoot.length - a.containerRoot.length ||
          MOUNT_SOURCE_PRIORITY[b.source] - MOUNT_SOURCE_PRIORITY[a.source],
      )
      .find((mount) => isPathInsideContainerRoot(mount.containerRoot, containerPath)) ?? null
  );
}

export function resolveRemoteMountByLocalPath(
  mounts: RemoteMountInfo[],
  localPath: string,
): RemoteMountInfo | null {
  return (
    mounts
      .toSorted(
        (a, b) =>
          b.localRoot.length - a.localRoot.length ||
          MOUNT_SOURCE_PRIORITY[b.source] - MOUNT_SOURCE_PRIORITY[a.source],
      )
      .find((mount) => isPathInside(mount.localRoot, localPath)) ?? null
  );
}

export function buildRemoteProtectedSkillRoots(params: {
  workspaceContainerRoot: string;
  agentContainerRoot: string;
  includeAgentMount: boolean;
}): string[] {
  return [
    params.workspaceContainerRoot,
    ...(params.includeAgentMount ? [params.agentContainerRoot] : []),
  ].flatMap((root) => [
    path.posix.join(root, "skills"),
    path.posix.join(root, ".agents", "skills"),
    path.posix.join(root, ".openclaw", "sandbox-skills", "skills"),
  ]);
}

export function normalizeContainerPath(value: string): string {
  const normalized = normalizeContainerPathCore(value.trim() || "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function toPosixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).filter(Boolean).join(path.posix.sep);
}
