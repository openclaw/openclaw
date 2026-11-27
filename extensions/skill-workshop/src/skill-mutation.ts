import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  commitSkillChange,
  listSkillCopyFiles,
  listSkillFiles,
} from "openclaw/plugin-sdk/skill-authoring-runtime";
import {
  readWorkshopActivity,
  recordWorkshopChange,
  type WorkshopActor,
  type WorkshopChange,
} from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import {
  listVersions,
  pruneVersions,
  type MutationPaths,
  type SkillPaths,
  type WorkshopChangeAction,
} from "./skill-versions.js";

export type WorkshopMutationContext = {
  config: OpenClawConfig;
  agentId: string;
  actor: WorkshopActor;
  sessionKey?: string;
  runId?: string;
  /** Throws once the caller lost write authority; checked under the skill locks before any write. */
  assertLive?: () => void;
};

const skillLocks = new KeyedAsyncQueue();

async function hasRecentSkillChange(
  ctx: WorkshopMutationContext,
  name: string,
  paths: SkillPaths,
  cutoffMs: number,
): Promise<boolean> {
  const recorded = await readWorkshopActivity(ctx.agentId, name);
  if (recorded !== null) {
    return recorded > cutoffMs;
  }

  // Older stores may already have evicted the successful removal from the public feed.
  // Its before-image alone also exists for a revoked edit; require an actual missing file.
  const recentRemovals = (await listVersions(paths.versionsDir)).filter(
    (version) => version.createdAtMs > cutoffMs && version.action === "remove_file",
  );
  if (recentRemovals.length === 0) {
    return false;
  }
  const current = new Set((await listSkillFiles({ ...paths.target, skillName: name })).files);
  for (const version of recentRemovals) {
    const copyDir = path.relative(paths.root, path.join(paths.versionsDir, version.id));
    const saved = await listSkillCopyFiles({ ...paths.target, copyDir });
    if (saved.files.some((file) => !current.has(file))) {
      return true;
    }
  }
  return false;
}

/** Sorted acquisition keeps overlapping multi-skill mutations from deadlocking. */
async function withSkillLocks<T>(keys: readonly string[], run: () => Promise<T>): Promise<T> {
  const [first, ...rest] = [...new Set(keys)].toSorted((a, b) => a.localeCompare(b));
  return first === undefined
    ? await run()
    : await skillLocks.enqueue(first, () => withSkillLocks(rest, run));
}

export type ApplySkillMutation = (
  paths: MutationPaths,
) => Promise<{ summary: string; versionId?: string }>;

export function prepareSkillMutation(
  ctx: WorkshopMutationContext,
  name: string,
  paths: SkillPaths,
  action: WorkshopChangeAction,
  apply: ApplySkillMutation,
  alsoLock: readonly SkillPaths[] = [],
) {
  const lockKeys = [paths.skillDir, ...alsoLock.map((other) => other.skillDir)];
  const commit = async (): Promise<WorkshopChange> => {
    ctx.assertLive?.();
    let change: WorkshopChange | undefined;
    // The host refreshes discovery, then the change is recorded, then skill_changed observers hear.
    await commitSkillChange({
      config: ctx.config,
      agentId: ctx.agentId,
      skillName: name,
      apply: async () => {
        // Checked at lock time to skip needless work, and again right before each file effect.
        const applied = await apply({ ...paths, assertLive: () => ctx.assertLive?.() });
        await pruneVersions(paths.versionsDir);
        return applied;
      },
      // The change log is written after discovery refresh, so a failed record never leaves a
      // committed skill undiscovered.
      beforeDispatch: async ({ summary, versionId }) => {
        change = {
          id: randomUUID(),
          agentId: ctx.agentId,
          skillName: name,
          action,
          actor: ctx.actor,
          summary,
          ...(versionId ? { versionId } : {}),
          ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
          ...(ctx.runId ? { runId: ctx.runId } : {}),
          createdAtMs: Date.now(),
        };
        await recordWorkshopChange(change);
      },
    });
    if (!change) {
      throw new Error("Skill change finished without a change record.");
    }
    return change;
  };
  return {
    commit: () => withSkillLocks(lockKeys, commit),
    commitIfInactiveSince: (cutoffMs: number) =>
      withSkillLocks(lockKeys, async () => {
        if (await hasRecentSkillChange(ctx, name, paths, cutoffMs)) {
          return undefined;
        }
        return await commit();
      }),
  };
}
