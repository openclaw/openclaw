import {
  deriveConceptTags,
  summarizeConceptTagScriptCoverage,
  type ConceptTagScriptCoverage,
} from "./concept-vocabulary.js";
import {
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
} from "./dreaming-state.js";
import {
  deleteShortTermLockEntryIfCurrent,
  isShortTermLockStealable,
  resolveLockPath,
  withMemoryWorkspaceLock,
} from "./memory-workspace-lock.js";
import { filterLiveShortTermRecallEntries } from "./short-term-promotion-record.js";
import {
  readPhaseSignalStore,
  readShortTermStore,
  readStore,
  resolveStorePath,
  writePhaseSignalStore,
  writeStore,
} from "./short-term-promotion-store.js";
import type {
  RepairShortTermPromotionArtifactsResult,
  ShortTermAuditIssue,
  ShortTermAuditSummary,
  ShortTermLockEntry,
} from "./short-term-promotion-types.js";
import {
  MAX_RECALL_DAYS,
  SHORT_TERM_RECALL_MAX_ENTRIES,
  enforceShortTermRecallStoreRetention,
  mergeRecentDistinct,
  normalizeIsoDay,
  normalizeShortTermRecallStore,
} from "./short-term-promotion-utils.js";

export { resolveStorePath as resolveShortTermRecallStorePath } from "./short-term-promotion-store.js";
export { resolveLockPath as resolveShortTermRecallLockPath } from "./memory-workspace-lock.js";

async function inspectStaleShortTermLock(workspaceDir: string, repair: boolean): Promise<boolean> {
  const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
  const lockStore = openMemoryCoreStateStore<ShortTermLockEntry>({
    namespace: SHORT_TERM_LOCK_NAMESPACE,
    maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
  });
  const lockEntry = await lockStore.lookup(lockKey);
  if (!lockEntry || !isShortTermLockStealable(lockEntry, Date.now())) {
    return false;
  }
  return repair ? await deleteShortTermLockEntryIfCurrent(lockStore, lockKey, lockEntry) : true;
}

export async function auditShortTermPromotionArtifacts(params: {
  workspaceDir: string;
}): Promise<ShortTermAuditSummary> {
  const workspaceDir = params.workspaceDir.trim();
  const storePath = resolveStorePath(workspaceDir);
  const lockPath = resolveLockPath(workspaceDir);
  const issues: ShortTermAuditIssue[] = [];
  let entryCount = 0;
  let promotedCount = 0;
  let spacedEntryCount = 0;
  let conceptTaggedEntryCount = 0;
  let conceptTagScripts: ConceptTagScriptCoverage | undefined;
  let invalidEntryCount = 0;
  let danglingEntryCount = 0;
  let updatedAt: string | undefined;

  const nowIso = new Date().toISOString();
  const raw = await readShortTermStore(workspaceDir, "recall", nowIso);
  const rawEntryCount = Object.keys(raw.entries).length;
  const exists = rawEntryCount > 0;
  if (exists) {
    const store = normalizeShortTermRecallStore(raw, nowIso);
    const entries = Object.values(store.entries);
    const taggedEntries = entries.filter((entry) => entry.conceptTags.length > 0);
    updatedAt = store.updatedAt;
    entryCount = entries.length;
    promotedCount = entries.filter((entry) => Boolean(entry.promotedAt)).length;
    spacedEntryCount = entries.filter((entry) => entry.recallDays.length > 1).length;
    conceptTaggedEntryCount = taggedEntries.length;
    conceptTagScripts = summarizeConceptTagScriptCoverage(
      taggedEntries.map((entry) => entry.conceptTags),
    );
    invalidEntryCount = rawEntryCount - entryCount;
    if (invalidEntryCount > 0) {
      issues.push({
        severity: "warn",
        code: "recall-store-invalid",
        message: `Short-term recall store contains ${invalidEntryCount} invalid entr${invalidEntryCount === 1 ? "y" : "ies"}.`,
        fixable: true,
      });
    }
    const liveEntries = await filterLiveShortTermRecallEntries({
      workspaceDir,
      entries,
    });
    danglingEntryCount = entryCount - liveEntries.length;
    if (danglingEntryCount > 0) {
      issues.push({
        severity: "warn",
        code: "recall-store-dangling",
        message: `Short-term recall store contains ${danglingEntryCount} entr${danglingEntryCount === 1 ? "y" : "ies"} whose source file is missing or not a regular file.`,
        fixable: true,
      });
    }
    if (entryCount > SHORT_TERM_RECALL_MAX_ENTRIES) {
      issues.push({
        severity: "warn",
        code: "recall-store-over-limit",
        message: `Short-term recall store contains ${entryCount} entries; only the newest ${SHORT_TERM_RECALL_MAX_ENTRIES} are kept at runtime.`,
        fixable: true,
      });
    }
  }

  if (await inspectStaleShortTermLock(workspaceDir, false)) {
    issues.push({
      severity: "warn",
      code: "recall-lock-stale",
      message: "Short-term promotion lock appears stale.",
      fixable: true,
    });
  }

  return {
    storePath,
    lockPath,
    updatedAt,
    exists,
    entryCount,
    promotedCount,
    spacedEntryCount,
    conceptTaggedEntryCount,
    ...(conceptTagScripts ? { conceptTagScripts } : {}),
    invalidEntryCount,
    danglingEntryCount,
    issues,
  };
}

export async function repairShortTermPromotionArtifacts(params: {
  workspaceDir: string;
}): Promise<RepairShortTermPromotionArtifactsResult> {
  const workspaceDir = params.workspaceDir.trim();
  const nowIso = new Date().toISOString();
  let rewroteStore = false;
  let removedInvalidEntries = 0;
  let removedDanglingEntries = 0;
  let removedOverflowEntries = 0;
  const removedStaleLock = await inspectStaleShortTermLock(workspaceDir, true);

  await withMemoryWorkspaceLock(workspaceDir, async () => {
    const raw = await readShortTermStore(workspaceDir, "recall", nowIso);
    const rawEntryCount = Object.keys(raw.entries).length;
    if (rawEntryCount > 0) {
      const store = normalizeShortTermRecallStore(raw, nowIso);
      const before = JSON.stringify(store.entries);
      removedInvalidEntries = Math.max(0, rawEntryCount - Object.keys(store.entries).length);
      for (const entry of Object.values(store.entries)) {
        const conceptTags = deriveConceptTags({ path: entry.path, snippet: entry.snippet });
        const fallbackDay = normalizeIsoDay(entry.lastRecalledAt) ?? nowIso.slice(0, 10);
        entry.recallDays = mergeRecentDistinct(entry.recallDays, fallbackDay, MAX_RECALL_DAYS);
        if (conceptTags.length > 0) {
          entry.conceptTags = conceptTags;
        }
      }
      const liveEntries = await filterLiveShortTermRecallEntries({
        workspaceDir,
        entries: Object.values(store.entries),
      });
      const liveEntryKeys = new Set(liveEntries.map((entry) => entry.key));
      const danglingEntryKeys = Object.keys(store.entries).filter((key) => !liveEntryKeys.has(key));
      removedDanglingEntries = danglingEntryKeys.length;
      for (const key of danglingEntryKeys) {
        delete store.entries[key];
      }
      removedOverflowEntries = enforceShortTermRecallStoreRetention(store);
      if (removedInvalidEntries > 0 || before !== JSON.stringify(store.entries)) {
        if (removedDanglingEntries > 0) {
          const phaseSignals = await readPhaseSignalStore(workspaceDir, nowIso);
          for (const key of danglingEntryKeys) {
            delete phaseSignals.entries[key];
          }
          phaseSignals.updatedAt = nowIso;
          // Remove derived signals first so a later recall write failure stays retryable.
          await writePhaseSignalStore(workspaceDir, phaseSignals);
        }
        await writeStore(workspaceDir, {
          ...store,
          updatedAt: nowIso,
        });
        rewroteStore = true;
      }
    }
  });

  return {
    changed: rewroteStore || removedStaleLock,
    removedInvalidEntries,
    removedDanglingEntries,
    removedOverflowEntries,
    rewroteStore,
    removedStaleLock,
  };
}

export async function removeGroundedShortTermCandidates(params: {
  workspaceDir: string;
}): Promise<{ removed: number; storePath: string }> {
  const workspaceDir = params.workspaceDir.trim();
  const storePath = resolveStorePath(workspaceDir);
  const nowIso = new Date().toISOString();
  let removed = 0;

  await withMemoryWorkspaceLock(workspaceDir, async () => {
    const [store, phaseSignals] = await Promise.all([
      readStore(workspaceDir, nowIso),
      readPhaseSignalStore(workspaceDir, nowIso),
    ]);

    for (const [key, entry] of Object.entries(store.entries)) {
      if (entry.groundedCount > 0 && entry.recallCount === 0 && entry.dailyCount === 0) {
        delete store.entries[key];
        removed += 1;
      }
    }

    for (const key of Object.keys(phaseSignals.entries)) {
      if (!Object.hasOwn(store.entries, key)) {
        delete phaseSignals.entries[key];
      }
    }

    if (removed > 0) {
      store.updatedAt = nowIso;
      phaseSignals.updatedAt = nowIso;
      const writes = [
        writeStore(workspaceDir, store),
        writePhaseSignalStore(workspaceDir, phaseSignals),
      ];
      try {
        await Promise.all(writes);
      } finally {
        // A failed write cannot release the workspace while its sibling still mutates it.
        await Promise.allSettled(writes);
      }
    }
  });

  return { removed, storePath };
}
