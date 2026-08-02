import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/security-runtime";
import type { WorkboardKeyedStore } from "./persistence-types.js";

const ARTIFACT_RETENTION_CLAIM_ID = "persisted-local-artifacts";

type WorktreeRetentionRuntime = Pick<PluginRuntime["worktrees"], "setRetentionClaim">;

async function retainedWorkspacePath(card: WorkboardCard | undefined): Promise<string | undefined> {
  const workspace = card?.metadata?.automation?.workspace;
  if (!card || card.metadata?.archivedAt || workspace?.kind !== "worktree" || !workspace.path) {
    return undefined;
  }
  const artifactPaths = (card.metadata?.artifacts ?? []).flatMap((artifact) =>
    artifact.path ? [artifact.path] : [],
  );
  if (artifactPaths.length === 0) {
    return undefined;
  }
  const workspaceRoot = path.resolve(workspace.path);
  try {
    const canonicalWorkspaceRoot = await canonicalPathFromExistingAncestor(workspaceRoot);
    for (const artifact of artifactPaths) {
      const artifactPath = path.resolve(workspaceRoot, artifact);
      const canonicalArtifactPath = await canonicalPathFromExistingAncestor(artifactPath);
      if (isPathInside(canonicalWorkspaceRoot, canonicalArtifactPath)) {
        return workspace.path;
      }
    }
  } catch {
    // A path-resolution failure must not turn persisted local state into an unprotected tree.
    return workspace.path;
  }
  return undefined;
}

async function setArtifactRetentionClaim(params: {
  worktrees: WorktreeRetentionRuntime;
  card: WorkboardCard;
  workspacePath: string;
  active: boolean;
}): Promise<void> {
  const accepted = await params.worktrees.setRetentionClaim({
    path: params.workspacePath,
    ownerKind: "workboard",
    ownerId: params.card.id,
    claimId: ARTIFACT_RETENTION_CLAIM_ID,
    active: params.active,
  });
  if (params.active && !accepted) {
    throw new Error(
      `managed worktree is unavailable for artifact retention: ${params.workspacePath}`,
    );
  }
}

export function withWorkboardArtifactRetention(
  store: WorkboardKeyedStore,
  worktrees: WorktreeRetentionRuntime,
): WorkboardKeyedStore {
  return {
    async register(key, value) {
      const previous = await store.lookup(key);
      const previousCard = previous?.version === 1 ? previous.card : undefined;
      const nextPath = await retainedWorkspacePath(value.card);
      const previousPath = await retainedWorkspacePath(previousCard);
      if (nextPath) {
        await setArtifactRetentionClaim({
          worktrees,
          card: value.card,
          workspacePath: nextPath,
          active: true,
        });
      }
      try {
        await store.register(key, value);
      } catch (error) {
        if (nextPath && nextPath !== previousPath) {
          await setArtifactRetentionClaim({
            worktrees,
            card: value.card,
            workspacePath: nextPath,
            active: false,
          }).catch(() => undefined);
        }
        throw error;
      }
      if (previousCard && previousPath && previousPath !== nextPath) {
        await setArtifactRetentionClaim({
          worktrees,
          card: previousCard,
          workspacePath: previousPath,
          active: false,
        });
      }
    },
    async lookup(key) {
      return await store.lookup(key);
    },
    async delete(key) {
      const previous = await store.lookup(key);
      const previousCard = previous?.version === 1 ? previous.card : undefined;
      const previousPath = await retainedWorkspacePath(previousCard);
      const deleted = await store.delete(key);
      if (deleted && previousCard && previousPath) {
        await setArtifactRetentionClaim({
          worktrees,
          card: previousCard,
          workspacePath: previousPath,
          active: false,
        });
      }
      return deleted;
    },
    async entries() {
      return await store.entries();
    },
  };
}
