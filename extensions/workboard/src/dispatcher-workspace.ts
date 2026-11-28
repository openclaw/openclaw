import type { WorkboardCard } from "@openclaw/workboard-contract";
// Workboard dispatch workspace helpers keep authority resolution outside the orchestration loop.
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  canonicalPathFromExistingAncestor,
  pathExists,
} from "openclaw/plugin-sdk/security-runtime";
import type { WorkboardStore } from "./store.js";
import {
  canonicalizeWorkboardWorkspaceAccess,
  intersectWorkboardWorkspaceAccess,
  type WorkboardTargetWorkspaceRuntime,
  type WorkboardWorkspaceAccess,
} from "./workspace-access.js";

export type ResolveAgentWorkspaceRuntime = (
  agentId: string | undefined,
  sessionKey: string,
  workspaceDir: string,
  modelProvider?: string,
  modelId?: string,
) => WorkboardTargetWorkspaceRuntime | Promise<WorkboardTargetWorkspaceRuntime>;

export function managedWorktreeName(cardId: string): string {
  const suffix = cardId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  return `wb-${suffix}`.slice(0, 64).replace(/-$/, "");
}

export type WorkboardWorktreeCleanupRuntime = Pick<PluginRuntime["worktrees"], "removeIfLossless">;

type WorkboardWorkspaceMutation = {
  before: WorkboardCard;
  after: WorkboardCard;
};

function hasTerminalWorkboardExecution(card: WorkboardCard): boolean {
  const status = card.execution?.status ?? card.status;
  return status === "review" || status === "blocked" || status === "done";
}

export function isWorkboardWorktreeCleanupCandidate(card: WorkboardCard): boolean {
  const workspace = card.metadata?.automation?.workspace;
  return Boolean(
    workspace?.kind === "worktree" &&
    workspace.path &&
    workspace.sourcePath &&
    hasTerminalWorkboardExecution(card),
  );
}

export async function cleanupWorkboardCardWorktree(params: {
  store: WorkboardStore;
  worktrees: WorkboardWorktreeCleanupRuntime;
  card: WorkboardCard;
  workspaceMutation?: WorkboardWorkspaceMutation;
}): Promise<void> {
  const current = await params.store.get(params.card.id);
  const workspace = (params.workspaceMutation?.after ?? current)?.metadata?.automation?.workspace;
  if (
    !current ||
    !hasTerminalWorkboardExecution(current) ||
    workspace?.kind !== "worktree" ||
    !workspace?.path ||
    !workspace.sourcePath
  ) {
    return;
  }
  const removed = await params.worktrees.removeIfLossless({
    path: workspace.path,
    ownerKind: "workboard",
    ownerId: params.card.id,
  });
  if (!removed && (await pathExists(workspace.path))) {
    return;
  }
  if (params.workspaceMutation) {
    await params.store.compensateWorkspaceMutation(
      params.workspaceMutation.before,
      params.workspaceMutation.after,
    );
    return;
  }
  await params.store.update(
    current.id,
    {
      workspace: {
        kind: "worktree",
        path: workspace.sourcePath,
        ...(workspace.sourceBranch ? { branch: workspace.sourceBranch } : {}),
      },
    },
    { expectedUpdatedAt: current.updatedAt },
  );
}

export async function resolveDispatchWorkspaceAccess(params: {
  card: WorkboardCard;
  currentAccess?: WorkboardWorkspaceAccess;
  resolveAgentWorkspace?: (agentId?: string) => string;
}): Promise<{
  workspaceAccess: WorkboardWorkspaceAccess;
  targetWorkspace?: string;
  persistWorkspaceAccess: boolean;
}> {
  const currentAccess = await canonicalizeWorkboardWorkspaceAccess(
    params.currentAccess ?? { unrestricted: true },
  );
  const persistedAccess = params.card.metadata?.automation?.workspaceAccess;
  const workspace = params.card.metadata?.automation?.workspace;
  let targetWorkspace: string | undefined;
  if (!persistedAccess?.unrestricted || !currentAccess.unrestricted) {
    const resolved = params.resolveAgentWorkspace?.(params.card.agentId);
    targetWorkspace = resolved ? await canonicalPathFromExistingAncestor(resolved) : undefined;
  }
  const cardAccess = persistedAccess
    ? await canonicalizeWorkboardWorkspaceAccess(persistedAccess)
    : currentAccess.unrestricted
      ? !workspace || workspace.kind === "scratch"
        ? currentAccess
        : (() => {
            throw new Error(
              "card workspace authority is unknown; re-save its workspace with current permissions before dispatch.",
            );
          })()
      : currentAccess;
  const workspaceAccess = intersectWorkboardWorkspaceAccess(cardAccess, currentAccess);
  if (!workspaceAccess.unrestricted && !workspaceAccess.writable) {
    throw new Error(
      "card workspace authority is read-only; manual movement is allowed but worker dispatch requires write access.",
    );
  }
  return {
    workspaceAccess,
    ...(targetWorkspace ? { targetWorkspace } : {}),
    persistWorkspaceAccess: !persistedAccess,
  };
}
