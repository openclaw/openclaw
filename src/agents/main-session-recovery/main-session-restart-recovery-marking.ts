import { randomUUID } from "node:crypto";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveStateDir } from "../../config/paths.js";
import type {
  InternalSessionEntry as SessionEntry,
  RestartRecoveryRun,
} from "../../config/sessions.js";
import {
  hasMainSessionRecoveryClaim,
  hasOrphanedMainSessionWork,
  hasRestartRecoveryTerminalRun,
  isMainRestartRecoveryCandidate,
  isRetryableUnadoptedChatClaim,
  normalizeMainSessionRecoveryRunFences,
} from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import {
  readSessionEntryReadOnlyInWorker,
  readSessionEntrySummariesInWorker,
} from "../../config/sessions/session-entry-read-runtime.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartRecoveryCandidate } from "../../gateway/chat-abort.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { hasLiveAgentRunContext, listAgentRunsForSession } from "../../infra/agent-run-registry.js";
import {
  captureGatewaySessionControllerWork,
  captureSessionControllerSettlement,
  isSessionControllerWorkActive,
} from "../../sessions/session-controller.lifecycle.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../../state/openclaw-agent-db.paths.js";
import {
  hasCompletedMainSessionRecoveryOutcome,
  isMainRestartRecoveryTerminalOnly,
  transitionMainSessionRecovery,
} from "./main-session-recovery-state.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import {
  recordStartupRecoveryStoreResult,
  restartRecoveryStoreTargetKey,
  type RestartRecoveryStoreTarget,
} from "./main-session-restart-recovery-diagnostics.js";
import {
  discoverRestartRecoveryStoreTargets,
  mainSessionRecoveryLog,
} from "./main-session-restart-recovery-shared.js";
import {
  captureYieldedMainSessionContinuation,
  resolveRestartRecoveryDispatchIdentity,
  resolveRestartRecoveryDispatchTarget,
} from "./main-session-restart-recovery-target.js";

async function markRecoveryStore(params: {
  agentId?: string;
  storePath: string;
  sessionKeys?: readonly string[];
  assertCommitAllowed?: () => void;
  plan: (
    entry: SessionEntry,
    sessionKey: string,
  ) =>
    | {
        action: "mark";
        forceRestartSafeTools?: boolean;
        replaceRuns?: boolean;
        runs?: RestartRecoveryRun[];
      }
    | { action: "retire_terminal" }
    | { action: "restore_yielded"; isCurrent: () => boolean }
    | undefined;
}) {
  const yieldOwners: Array<() => boolean> = [];
  return await applySessionEntryReplacements<{ marked: number; skipped: number }>({
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKeys: params.sessionKeys,
    requireWriteSuccess: true,
    assertCommitAllowed: () => {
      params.assertCommitAllowed?.();
      if (yieldOwners.some((isCurrent) => !isCurrent())) {
        throw new Error("Yielded requester continuation changed before recovery handoff");
      }
    },
    update: (entries) => {
      const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
      const counts = { marked: 0, skipped: 0 };
      for (const { sessionKey, entry } of entries) {
        const plan = params.plan(entry, sessionKey);
        if (!plan) {
          continue;
        }
        if (!isMainRestartRecoveryCandidate(entry, sessionKey)) {
          counts.skipped++;
          continue;
        }
        if (plan.action !== "mark") {
          if (plan.action === "restore_yielded") {
            yieldOwners.push(plan.isCurrent);
          }
          transitionMainSessionRecovery(
            entry,
            plan.action === "restore_yielded"
              ? { kind: "clear" }
              : {
                  kind: "observe",
                  cycleId: randomUUID(),
                  lifecycleGeneration: getAgentEventLifecycleGeneration(),
                  sessionKey,
                },
          );
          replacements.push({ sessionKey, entry });
          counts.skipped++;
          continue;
        }
        if (plan.replaceRuns) {
          entry.restartRecoveryRuns = plan.runs;
        }
        if (plan.forceRestartSafeTools) {
          entry.restartRecoveryForceSafeTools = true;
        }
        transitionMainSessionRecovery(entry, {
          kind: "mark_interrupted",
          cycleId: randomUUID(),
          now: Date.now(),
          ...plan,
        });
        replacements.push({ sessionKey, entry });
        counts.marked++;
      }
      return { result: counts, replacements };
    },
  });
}

export async function markRestartAbortedMainSessions(params: {
  resolveGatewayContext: GatewayContextResolver;
  cfg?: OpenClawConfig;
  stateDir?: string;
  activeRuns: Iterable<RestartRecoveryCandidate>;
  activeAdmissions?: ReturnType<typeof captureGatewaySessionControllerWork>;
  isActiveRun?: (run: RestartRecoveryCandidate) => boolean;
  reason?: string;
}): Promise<{ marked: number; skipped: number }> {
  const activeRuns = [...params.activeRuns];
  const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
  const result = { marked: 0, skipped: 0 };
  const skipReasons = new Map<string, number>();
  const skippedSessions = new Set<string>();
  const markedSessions = new Set<string>();
  const recordSkip = (reason: string, sessionKey: string) => {
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    if (skippedSessions.has(sessionKey)) {
      return;
    }
    skippedSessions.add(sessionKey);
    if (skippedSessions.size <= 100) {
      mainSessionRecoveryLog.warn(
        `skipped restart recovery session: ${JSON.stringify({ sessionKey: sessionKey.slice(0, 256), reason })}`,
      );
    }
  };
  // Channel work can outlive its chat-run registration. The admission owner
  // retains the authoritative store and session identities until the turn releases.
  const activeAdmissions =
    params.activeAdmissions ?? captureGatewaySessionControllerWork(params.resolveGatewayContext);
  if (activeRuns.length === 0 && activeAdmissions.targets.size === 0) {
    return result;
  }

  const storeTargets = new Map<string, RestartRecoveryStoreTarget>();
  const addStoreTarget = (target: RestartRecoveryStoreTarget) => {
    // Volatile admissions belong to this process and cannot survive its restart.
    if (resolveExplicitIncognitoAgentSqliteTarget(target.storePath, target)) {
      return;
    }
    const resolved = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId: target.agentId,
    });
    // One logical scope can name multiple flat-store databases. Alias scopes still
    // retain their own admission checks even when they reach the same database.
    const key = JSON.stringify([target.storePath, resolved.path]);
    if (!storeTargets.has(key)) {
      storeTargets.set(key, target);
    }
  };
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  try {
    for (const target of await discoverRestartRecoveryStoreTargets({ cfg: params.cfg, stateDir })) {
      addStoreTarget(target);
    }
  } catch (err) {
    if (!params.cfg) {
      throw err;
    }
    mainSessionRecoveryLog.warn(
      `failed to resolve configured session stores for restart marker: ${String(err)}`,
    );
  }

  for (const storePath of activeAdmissions.targets.keys()) {
    addStoreTarget({ storePath });
  }
  for (const run of activeRuns) {
    addStoreTarget({ storePath: run.storePath, agentId: run.agentId });
  }
  for (const target of storeTargets.values()) {
    const { storePath } = target;
    // Preselect read-only: ID-only admissions can own multiple persisted keys.
    // The per-key replacement below rereads the row and revalidates its owner.
    const sessionKeys = (await readSessionEntrySummariesInWorker(target))
      .filter(
        ({ sessionKey, entry }) =>
          activeRuns.some(
            (run) =>
              run.storePath === storePath &&
              run.sessionKey === sessionKey &&
              run.sessionId === entry.sessionId,
          ) ||
          activeAdmissions.isActive({ scope: storePath, sessionKey, sessionId: entry.sessionId }),
      )
      .map(({ sessionKey }) => sessionKey);
    for (const selectedSessionKey of sessionKeys) {
      let isCurrent: (() => boolean) | undefined;
      try {
        const requester = await resolveRestartRecoveryDispatchTarget({
          storeAgentId: target.agentId,
          cfg: params.cfg,
          sessionKey: selectedSessionKey,
          storePath,
        });
        const agentId =
          requester?.agentId ??
          resolveRestartRecoveryDispatchIdentity({
            storeAgentId: target.agentId,
            sessionKey: selectedSessionKey,
            storePath,
          }).agentId;
        const storeResult = await markRecoveryStore({
          ...target,
          sessionKeys: [selectedSessionKey],
          assertCommitAllowed: () => {
            if (isCurrent && !isCurrent()) {
              throw new Error("Restart recovery owner changed before commit");
            }
          },
          plan: (entry, sessionKey) => {
            // The shutdown owner supplies paired identities. Recheck ownership after
            // store discovery; an ID collision must not select a row or attach its fences.
            const matchingActiveRuns = activeRuns.filter(
              (run) =>
                run.storePath === storePath &&
                run.agentId === agentId &&
                run.sessionKey === sessionKey &&
                run.sessionId === entry.sessionId &&
                (entry.lifecycleRunId === run.runId ||
                  entry.restartRecoveryDeliveryRunId === run.runId ||
                  // Terminal persistence clears lifecycleRunId but retains this paired fence.
                  (entry.status === "interrupted" &&
                    entry.abortedLastRun === true &&
                    entry.lastRunId === run.runId &&
                    entry.restartRecoveryRuns?.some(
                      (fence) =>
                        fence.runId === (run.sourceRunId ?? run.runId) &&
                        fence.lifecycleGeneration === run.lifecycleGeneration,
                    )) ||
                  run.observedAt === undefined ||
                  asFiniteNumber(entry.updatedAt) === undefined ||
                  (entry.updatedAt < run.observedAt &&
                    run.lifecycleGeneration !== currentLifecycleGeneration)) &&
                params.isActiveRun?.(run) !== false,
            );
            const matchedActiveAdmission = activeAdmissions.isActive({
              scope: storePath,
              agentId,
              sessionKey,
              sessionId: entry.sessionId,
            });
            if (matchingActiveRuns.length === 0 && !matchedActiveAdmission) {
              recordSkip("owner_changed", sessionKey);
              return undefined;
            }
            if (
              captureYieldedMainSessionContinuation({
                entry,
                requester,
              })
            ) {
              recordSkip("yielded_continuation", sessionKey);
              return undefined;
            }
            if (!isMainRestartRecoveryCandidate(entry, sessionKey)) {
              recordSkip("not_main_session", sessionKey);
            }
            const runs = normalizeMainSessionRecoveryRunFences([
              ...(entry.restartRecoveryRuns ?? []).filter(
                (run) => run.lifecycleGeneration === currentLifecycleGeneration,
              ),
              ...listAgentRunsForSession({ sessionKey, sessionId: entry.sessionId }),
              ...matchingActiveRuns.map(({ runId, lifecycleGeneration }) => ({
                runId,
                lifecycleGeneration,
              })),
            ]);
            // Planning yields before SQLite commits. Revalidate the captured owners
            // in its synchronous guard, not just while selecting this row.
            isCurrent = () =>
              isAgentEventLifecycleGenerationCurrent(currentLifecycleGeneration) &&
              ((matchedActiveAdmission &&
                activeAdmissions.isActive({
                  scope: storePath,
                  agentId,
                  sessionKey,
                  sessionId: entry.sessionId,
                })) ||
                matchingActiveRuns.some((run) => params.isActiveRun?.(run) !== false));
            return {
              action: "mark",
              forceRestartSafeTools: matchedActiveAdmission,
              replaceRuns: true,
              runs,
            };
          },
        });
        result.marked += storeResult.marked;
        result.skipped += storeResult.skipped;
        if (storeResult.marked > 0) {
          markedSessions.add(selectedSessionKey);
        }
      } catch (error) {
        assertAgentRunLifecycleGenerationCurrent(currentLifecycleGeneration);
        if (!isCurrent || isCurrent()) {
          throw error;
        }
        result.skipped++;
        recordSkip("owner_changed", selectedSessionKey);
      }
    }
  }

  for (const run of activeRuns) {
    if (!markedSessions.has(run.sessionKey) && !skippedSessions.has(run.sessionKey)) {
      recordSkip("no_matching_session", run.sessionKey);
    }
  }
  if (skippedSessions.size > 100) {
    mainSessionRecoveryLog.warn(
      `restart recovery skip diagnostics omitted ${skippedSessions.size - 100} additional session(s)`,
    );
  }
  if (result.marked > 0) {
    mainSessionRecoveryLog.warn(
      `marked ${result.marked} interrupted main session(s) for restart recovery${
        params.reason ? ` (${params.reason})` : ""
      }`,
    );
  } else if (activeRuns.length > 0) {
    const dominantSkipReason = [...skipReasons].toSorted((a, b) => b[1] - a[1])[0]?.[0];
    mainSessionRecoveryLog.warn(
      `marked 0 interrupted main session(s) for restart recovery: activeRuns=${activeRuns.length} skipped=${result.skipped} skipReason=${dominantSkipReason ?? "no_matching_session"}${
        params.reason ? ` (${params.reason})` : ""
      }`,
    );
  }
  return result;
}

type OrphanMarkParams = {
  cfg?: OpenClawConfig;
  updatedBeforeMs?: number;
  lifecycleGeneration: string;
  onOwnerPending?: (
    target: RestartRecoveryStoreTarget & { sessionKey: string; sessionId: string },
    settled: Promise<void>,
  ) => void;
};

async function markOrphanedMainSessionStore(
  params: OrphanMarkParams & {
    target: RestartRecoveryStoreTarget & { sessionKey?: string };
    expectedSessionId?: string;
    expectedLifecycleRevision?: string;
    assertCommitAllowed?: () => void;
  },
): Promise<{ marked: number; skipped: number }> {
  const updatedBeforeMs = asFiniteNumber(params.updatedBeforeMs);
  const key = params.target.sessionKey;
  let sessionKeys: string[];
  if (key) {
    const entry = await readSessionEntryReadOnlyInWorker({ ...params.target, sessionKey: key });
    sessionKeys = entry && hasOrphanedMainSessionWork(entry, key) ? [key] : [];
  } else {
    sessionKeys = (
      await readSessionEntrySummariesInWorker({ ...params.target, mainSessionRecovery: "orphans" })
    ).map(({ sessionKey }) => sessionKey);
  }
  if (sessionKeys.length === 0) {
    return { marked: 0, skipped: 0 };
  }

  const requesters = new Map<
    string,
    Awaited<ReturnType<typeof resolveRestartRecoveryDispatchTarget>>
  >();
  for (const sessionKey of sessionKeys) {
    requesters.set(
      sessionKey,
      await resolveRestartRecoveryDispatchTarget({
        storeAgentId: params.target.agentId,
        cfg: params.cfg,
        sessionKey,
        storePath: params.target.storePath,
      }),
    );
  }
  const orphanChecks: Array<() => boolean> = [];
  return await markRecoveryStore({
    ...params.target,
    sessionKeys,
    assertCommitAllowed: () => {
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      params.assertCommitAllowed?.();
      if (orphanChecks.some((hasLiveOwner) => hasLiveOwner())) {
        throw new Error("Startup orphan acquired a live owner before recovery commit");
      }
    },
    plan: (entry, sessionKey) => {
      params.assertCommitAllowed?.();
      if (
        !hasOrphanedMainSessionWork(entry, sessionKey) ||
        isRetryableUnadoptedChatClaim(entry) ||
        entry.mainRestartRecovery?.tombstone ||
        (params.expectedSessionId !== undefined && entry.sessionId !== params.expectedSessionId) ||
        (params.expectedLifecycleRevision !== undefined &&
          entry.lifecycleRevision !== params.expectedLifecycleRevision)
      ) {
        return undefined;
      }
      const updatedAt = asFiniteNumber(entry.updatedAt);
      if (updatedBeforeMs !== undefined && updatedAt !== undefined && updatedAt > updatedBeforeMs) {
        return undefined;
      }
      const writerRunIds = [
        entry.activeWriterRunId,
        entry.lifecycleRunId,
        ...(entry.restartRecoveryRuns ?? []).map((run) => run.runId),
      ];
      const hasLiveOwner = () =>
        writerRunIds.some((runId) => runId && hasLiveAgentRunContext(runId)) ||
        listAgentRunsForSession({ sessionKey, sessionId: entry.sessionId }).some(({ runId }) =>
          hasLiveAgentRunContext(runId),
        ) ||
        isSessionControllerWorkActive(params.target.storePath, [sessionKey, entry.sessionId]);
      if (hasLiveOwner()) {
        const settled = captureSessionControllerSettlement({
          scope: params.target.storePath,
          identities: [sessionKey, entry.sessionId],
        });
        if (settled) {
          params.onOwnerPending?.(
            { ...params.target, sessionKey, sessionId: entry.sessionId },
            settled,
          );
        }
        return undefined;
      }
      const continuation = captureYieldedMainSessionContinuation({
        entry,
        requester: requesters.get(sessionKey),
      });
      if (continuation) {
        // A newer foreground start clears endedAt. Only an unclaimed waiting cycle
        // may hand its interruption marker back to the exact durable child batch.
        const state = entry.mainRestartRecovery;
        if (
          entry.abortedLastRun === true &&
          !state?.reservation &&
          !state?.foregroundClaims &&
          !state?.tombstone &&
          !entry.restartRecoveryDeliveryRunId
        ) {
          return {
            action: "restore_yielded",
            isCurrent: () => continuation() && !hasLiveOwner(),
          };
        }
        return undefined;
      }
      // A crash or early restart abort can persist the interruption without a claim.
      // Reuse the normal mark transition, preserving budgets on existing cycles.
      const hasClaim = hasMainSessionRecoveryClaim(entry);
      const completed = hasCompletedMainSessionRecoveryOutcome(entry);
      // A receipt for this continuation wins even when its saved outcome is interrupted.
      if (
        !hasClaim &&
        (completed ||
          [
            entry.lifecycleRunId,
            entry.activeWriterRunId,
            entry.restartRecoveryDeliverySourceRunId,
          ].some((runId) => runId !== undefined && hasRestartRecoveryTerminalRun(entry, runId)))
      ) {
        return undefined;
      }
      if (
        hasClaim &&
        !completed &&
        (entry.abortedLastRun === true ||
          (!entry.pendingFinalDelivery &&
            entry.status !== undefined &&
            entry.status !== "failed" &&
            entry.status !== "interrupted"))
      ) {
        return undefined;
      }
      orphanChecks.push(hasLiveOwner);
      return completed || isMainRestartRecoveryTerminalOnly(entry)
        ? { action: "retire_terminal" }
        : { action: "mark" };
    },
  });
}

/** Reconcile one exact session through the same owner used by startup. */
export async function markOrphanedMainSessionForRecovery(params: {
  target: MainSessionRecoveryStoreTarget;
  expectedSessionId: string;
  expectedLifecycleRevision?: string;
  cfg?: OpenClawConfig;
  assertCommitAllowed?: () => void;
}): Promise<{ marked: number; skipped: number }> {
  return await markOrphanedMainSessionStore({
    ...params,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
  });
}

export async function markStartupOrphanedMainSessionsForRecovery(params: {
  cfg?: OpenClawConfig;
  agentIds?: ReadonlySet<string>;
  stateDir?: string;
  startupCheckedStorePaths?: Set<string>;
  updatedBeforeMs?: number;
  onOwnerPending?: OrphanMarkParams["onOwnerPending"];
}): Promise<{ marked: number; skipped: number; failedTargets?: RestartRecoveryStoreTarget[] }> {
  const result = { marked: 0, skipped: 0 };
  const failedTargets: RestartRecoveryStoreTarget[] = [];
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const storeTargets = await discoverRestartRecoveryStoreTargets(params);
  for (const target of storeTargets) {
    const key = restartRecoveryStoreTargetKey(target);
    if (params.startupCheckedStorePaths?.has(key)) {
      continue;
    }
    try {
      const storeResult = await markOrphanedMainSessionStore({
        ...params,
        target,
        lifecycleGeneration,
      });
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
      result.marked += storeResult.marked;
      result.skipped += storeResult.skipped;
      params.startupCheckedStorePaths?.add(key);
      recordStartupRecoveryStoreResult({ target, outcome: { ok: true } });
    } catch (error) {
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
      failedTargets.push(target);
      recordStartupRecoveryStoreResult({
        target,
        outcome: { ok: false, error },
      });
      mainSessionRecoveryLog.warn(
        `failed to mark startup-orphaned main sessions for ${target.agentId}: ${String(error)}`,
      );
    }
  }

  if (result.marked > 0) {
    mainSessionRecoveryLog.warn(
      `marked ${result.marked} startup-orphaned main session(s) for restart recovery`,
    );
  }
  return { ...result, ...(failedTargets.length > 0 ? { failedTargets } : {}) };
}
