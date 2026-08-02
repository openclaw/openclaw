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

export type WorkboardArtifactRetentionStore = WorkboardKeyedStore & {
  reconcileArtifactRetention(): Promise<void>;
};

function worktreeWorkspacePath(card: WorkboardCard | undefined): string | undefined {
  const workspace = card?.metadata?.automation?.workspace;
  return workspace?.kind === "worktree" && workspace.path ? workspace.path : undefined;
}

async function retainedWorkspacePath(card: WorkboardCard | undefined): Promise<string | undefined> {
  const workspacePath = worktreeWorkspacePath(card);
  if (!card || card.metadata?.archivedAt || !workspacePath) {
    return undefined;
  }
  const artifactPaths = (card.metadata?.artifacts ?? []).flatMap((artifact) =>
    artifact.path ? [artifact.path] : [],
  );
  if (artifactPaths.length === 0) {
    return undefined;
  }
  const workspaceRoot = path.resolve(workspacePath);
  try {
    const canonicalWorkspaceRoot = await canonicalPathFromExistingAncestor(workspaceRoot);
    for (const artifact of artifactPaths) {
      const artifactPath = path.resolve(workspaceRoot, artifact);
      const canonicalArtifactPath = await canonicalPathFromExistingAncestor(artifactPath);
      if (isPathInside(canonicalWorkspaceRoot, canonicalArtifactPath)) {
        return workspacePath;
      }
    }
  } catch {
    // A path-resolution failure must not turn persisted local state into an unprotected tree.
    return workspacePath;
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
): WorkboardArtifactRetentionStore {
  let reconciliation: Promise<void> | undefined;
  const reconcileArtifactRetention = () => {
    reconciliation ??= (async () => {
      for (const entry of await store.entries()) {
        const card = entry.value?.version === 1 ? entry.value.card : undefined;
        const workspacePath = worktreeWorkspacePath(card);
        if (!card || !workspacePath) {
          continue;
        }
        await setArtifactRetentionClaim({
          worktrees,
          card,
          workspacePath,
          active: Boolean(await retainedWorkspacePath(card)),
        });
      }
    })().catch((error: unknown) => {
      reconciliation = undefined;
      throw error;
    });
    return reconciliation;
  };

  return {
    reconcileArtifactRetention,
    async register(key, value) {
      await reconcileArtifactRetention();
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
      await reconcileArtifactRetention();
      return await store.lookup(key);
    },
    async delete(key) {
      await reconcileArtifactRetention();
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
      await reconcileArtifactRetention();
      return await store.entries();
    },
  };
}
