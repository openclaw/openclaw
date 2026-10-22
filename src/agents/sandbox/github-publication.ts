import type { SandboxFsBridge } from "./fs-bridge.types.js";
import type { SandboxContext } from "./types.js";

/** Managed workspaces prepare in place; an unbound local Docker or Podman sandbox adopts one. */
export function canPrepareGitHubPullRequest(
  sandbox: SandboxContext | null | undefined,
): sandbox is SandboxContext {
  return Boolean(
    sandbox?.enabled &&
    sandbox.backend &&
    sandbox.workspaceAccess !== "ro" &&
    (sandbox.workspaceSource === "managed-worktree" ||
      sandbox.backendId === "docker" ||
      sandbox.backendId === "podman"),
  );
}

export function canRefreshGitHubPublicationBase(
  sandbox: SandboxContext | null | undefined,
): sandbox is SandboxContext {
  return Boolean(
    sandbox?.enabled &&
    sandbox.backend &&
    sandbox.workspaceSource === "managed-worktree" &&
    sandbox.workspaceAccess !== "ro",
  );
}

export function canUploadGitHubPublicationEvidence(
  sandbox: SandboxContext | null | undefined,
): sandbox is SandboxContext & {
  fsBridge: SandboxFsBridge & Required<Pick<SandboxFsBridge, "readFileWithSource">>;
} {
  return Boolean(sandbox?.enabled && sandbox.fsBridge?.readFileWithSource !== undefined);
}
