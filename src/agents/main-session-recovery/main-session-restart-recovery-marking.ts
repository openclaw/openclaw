import { randomUUID } from "node:crypto";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveStateDir } from "../../config/paths.js";
import type {
  InternalSessionEntry as SessionEntry,
  RestartRecoveryRun,
} from "../../config/sessions.js";
import { isCapturedMainRestartTurnCurrent } from "../../config/sessions/main-session-recovery.types.js";
import {
  hasMainSessionRecoveryClaim,
  isMainRestartRecoveryCandidate,
  normalizeMainSessionRecoveryRunFences,
} from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { withSessionHistoryWorkerDatabase } from "../../config/sessions/session-transcript-worker-runtime.js";
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
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../../routing/session-key.js";
import { captureGatewaySessionWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import { createCurrentProcessOwnerLookup } from "./main-session-recovery-live-owners.js";
import {
  isMainRestartRecoveryTerminalOnly,
  isCapturedMainRestartGoalCurrent,
  isMainSessionRecoveryIntentCurrent,
  isMainSessionRecoveryReconciliationCandidate,
  transitionMainSessionRecovery,
} from "./main-session-recovery-state.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { promoteQueuedMainSessionInput } from "./main-session-recovery-store.js";
import {
  recordStartupRecoveryStoreResult,
  restartRecoveryStoreTargetKey,
  type RestartRecoveryStoreTarget,
} from "./main-session-restart-recovery-diagnostics.js";
import {
  discoverRestartRecoveryStoreTargets,
  mainSessionRecoveryLog,
} from "./main-session-restart-recovery-shared.js";
import { captureYieldedMainSessionContinuation } from "./main-session-restart-recovery-target.js";

async function markRecoveryStore(params: {
  agentId?: string;
  storePath: string;
  sessionKey?: string;
  assertCommitAllowed?: () => void;
  plan: (
    entry: SessionEntry,
    sessionKey: string,
  ) =>
    | {
        action: "mark";
        forceRestartSafeTools?: boolean;
        replaceRuns?: boolean;
        resetRuntime?: boolean;
        runs?: RestartRecoveryRun[];
      }
    | { action: "retire_terminal" }
    | { action: "restore_yielded"; isCurrent: () => boolean }
    | { action: "capture_goal" }
    | undefined;
}) {
  const yieldOwners: Array<() => boolean> = [];
  return await applySessionEntryReplacements<{ marked: number; skipped: number }>({
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKeys: params.sessionKey ? [params.sessionKey] : undefined,
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
        if (plan.action === "capture_goal") {
          if (entry.goal?.status === "active" && entry.archivedAt === undefined) {
            entry.restartRecoveryGoal = {
              id: entry.goal.id,
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
              capturedAtMs: Date.now(),
            };
            replacements.push({ sessionKey, entry });
            counts.marked++;
          }
          continue;
        }
        if (plan.action === "restore_yielded") {
          yieldOwners.push(plan.isCurrent);
          transitionMainSessionRecovery(entry, { kind: "clear" });
          replacements.push({ sessionKey, entry });
          counts.skipped++;
          continue;
        }
        if (plan.action === "retire_terminal") {
          transitionMainSessionRecovery(entry, {
            kind: "observe",
            cycleId: randomUUID(),
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            sessionKey,
          });
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
  additionalCfgs?: Iterable<OpenClawConfig | undefined>;
  stateDir?: string;
  activeRuns: Iterable<RestartRecoveryCandidate>;
  isActiveRun?: (run: RestartRecoveryCandidate) => boolean;
  reason?: string;
  captureGoals?: true;
  assertCommitAllowed?: () => void;
}): Promise<{ marked: number; skipped: number }> {
  const activeRuns = [...params.activeRuns];
  const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
  const result = { marked: 0, skipped: 0 };
  // Channel work can outlive its chat-run registration. The admission owner
  // retains the authoritative store and session identities until the turn releases.
  const activeAdmissions = captureGatewaySessionWorkAdmissions(params.resolveGatewayContext);
  if (!params.captureGoals && activeRuns.length === 0 && activeAdmissions.targets.size === 0) {
    return result;
  }

  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  const storeTargets = new Map<
    string,
    RestartRecoveryStoreTarget & {
      database: { agentId: string; path: string };
    }
  >();
  const addStoreTarget = async (target: RestartRecoveryStoreTarget) => {
    const resolved = await prepareSqliteTargetFromSessionStorePath(target.storePath, {
      agentId: target.agentId,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    // One logical scope can name multiple flat-store databases. Alias scopes still
    // retain their own admission checks even when they reach the same database.
    const key = JSON.stringify([target.storePath, resolved.path]);
    if (!storeTargets.has(key)) {
      storeTargets.set(key, {
        ...target,
        database: {
          agentId: resolved.agentId ?? target.agentId ?? LEGACY_IMPLICIT_AGENT_ID,
          path: resolved.path,
        },
      });
    }
  };
  const configs = [params.cfg, ...(params.additionalCfgs ?? [])].filter(Boolean);
  for (const cfg of configs.length > 0 ? configs : [undefined]) {
    try {
      for (const target of await discoverRestartRecoveryStoreTargets({ cfg, stateDir })) {
        await addStoreTarget(target);
      }
    } catch (err) {
      if (!cfg) {
        throw err;
      }
      mainSessionRecoveryLog.warn(
        `failed to resolve configured session stores for restart marker: ${String(err)}`,
      );
    }
  }

  for (const storePath of activeAdmissions.targets.keys()) {
    await addStoreTarget({ storePath });
  }
  for (const { database, ...target } of storeTargets.values()) {
    const { storePath } = target;
    // Preselect read-only: ID-only admissions can own multiple persisted keys.
    // The per-key replacement below rereads the row and revalidates its owner.
    // The worker snapshot and later writer must retain this same physical store.
    const source = readDatabasePathIdentitySync(database.path);
    const snapshot = await withSessionHistoryWorkerDatabase(database, async (reader) => {
      const selectedEntries = await reader.readExactEntries({
        sessionKeys: [],
        projection: "replacement",
        replacementSelection: {},
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      reader.assertCurrent();
      return selectedEntries;
    });
    const entries = snapshot.replacement?.entries ?? [];
    const assertStoreCurrent = () => {
      params.assertCommitAllowed?.();
      assertAgentRunLifecycleGenerationCurrent(currentLifecycleGeneration);
      if (entries.length > 0) {
        if (source.key !== `file:${snapshot.replacement?.databaseIdentity}`) {
          throw new Error("Restart recovery selection lost its physical session store");
        }
        assertExistingDatabaseIdentity(database.path, source.key, source.birthtime);
        assertExistingDatabaseIdentity(source.canonicalPath, source.key, source.birthtime);
      }
    };
    assertStoreCurrent();
    const sessionKeys = entries
      .filter(
        ({ sessionKey, entry }) =>
          (params.captureGoals &&
            entry.goal?.status === "active" &&
            entry.archivedAt === undefined) ||
          activeRuns.some(
            (run) => run.sessionKey === sessionKey && run.sessionId === entry.sessionId,
          ) ||
          activeAdmissions.isActive({ scope: storePath, sessionKey, sessionId: entry.sessionId }),
      )
      .map(({ sessionKey }) => sessionKey);
    for (const selectedSessionKey of sessionKeys) {
      let isCurrent: (() => boolean) | undefined;
      try {
        const storeResult = await markRecoveryStore({
          ...target,
          sessionKey: selectedSessionKey,
          assertCommitAllowed: () => {
            assertStoreCurrent();
            if (isCurrent && !isCurrent()) {
              throw new Error("Restart recovery owner changed before commit");
            }
          },
          plan: (entry, sessionKey) => {
            if (
              params.captureGoals &&
              (entry.mainRestartRecovery?.pause ||
                entry.archivedAt !== undefined ||
                (entry.goal &&
                  entry.goal.status !== "active" &&
                  !isCapturedMainRestartGoalCurrent(entry)))
            ) {
              return undefined;
            }
            // The shutdown owner supplies paired identities. Recheck ownership after
            // store discovery; an ID collision must not select a row or attach its fences.
            const matchingActiveRuns = activeRuns.filter(
              (run) =>
                run.sessionKey === sessionKey &&
                run.sessionId === entry.sessionId &&
                (entry.lifecycleRunId === run.runId ||
                  run.accepted === true ||
                  (params.captureGoals && params.isActiveRun?.(run) === true) ||
                  run.observedAt === undefined ||
                  asFiniteNumber(entry.updatedAt) === undefined ||
                  (entry.updatedAt < run.observedAt &&
                    run.lifecycleGeneration !== currentLifecycleGeneration)) &&
                params.isActiveRun?.(run) !== false,
            );
            const matchedActiveAdmission = activeAdmissions.isActive({
              scope: storePath,
              sessionKey,
              sessionId: entry.sessionId,
            });
            if (
              matchingActiveRuns.length === 0 &&
              activeRuns.some(
                (run) => run.sessionKey === sessionKey && run.sessionId === entry.sessionId,
              )
            ) {
              // A retained session lease cannot replace its captured caller after
              // completion, cancellation or source revocation during discovery.
              return undefined;
            }
            if (matchingActiveRuns.length === 0 && !matchedActiveAdmission) {
              return params.captureGoals &&
                entry.goal?.status === "active" &&
                entry.archivedAt === undefined
                ? { action: "capture_goal" }
                : undefined;
            }
            if (
              captureYieldedMainSessionContinuation({
                storeAgentId: target.agentId,
                cfg: params.cfg,
                entry,
                sessionKey,
                storePath,
              })
            ) {
              return undefined;
            }
            if (
              params.captureGoals &&
              entry.goal?.status === "active" &&
              entry.archivedAt === undefined
            ) {
              entry.restartRecoveryGoal = {
                id: entry.goal.id,
                sessionId: entry.sessionId,
                lifecycleRevision: entry.lifecycleRevision,
                capturedAtMs: Date.now(),
              };
            } else if (entry.restartRecoveryGoal && !isCapturedMainRestartGoalCurrent(entry)) {
              entry.restartRecoveryGoal = undefined;
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
              (matchingActiveRuns.length > 0
                ? matchingActiveRuns.some((run) => params.isActiveRun?.(run) !== false)
                : matchedActiveAdmission &&
                  activeAdmissions.isActive({
                    scope: storePath,
                    sessionKey,
                    sessionId: entry.sessionId,
                  }));
            return {
              action: "mark",
              forceRestartSafeTools: matchedActiveAdmission,
              replaceRuns: true,
              resetRuntime: entry.lifecycleRunId === undefined,
              runs,
            };
          },
        });
        result.marked += storeResult.marked;
        result.skipped += storeResult.skipped;
      } catch (error) {
        assertAgentRunLifecycleGenerationCurrent(currentLifecycleGeneration);
        if (!isCurrent || isCurrent()) {
          throw error;
        }
        result.skipped++;
      }
    }
  }

  if (result.marked > 0) {
    mainSessionRecoveryLog.warn(
      `marked ${result.marked} interrupted main session(s) for restart recovery${
        params.reason ? ` (${params.reason})` : ""
      }`,
    );
  }
  return result;
}

type OrphanMarkParams = {
  cfg?: OpenClawConfig;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  updatedBeforeMs?: number;
  lifecycleGeneration: string;
};

async function markOrphanedMainSessionStore(
  params: OrphanMarkParams & {
    target: RestartRecoveryStoreTarget & { sessionKey?: string };
    expectedSessionId?: string;
    expectedLifecycleRevision?: string;
    assertCommitAllowed?: () => void;
  },
): Promise<{ marked: number; skipped: number }> {
  const hasCurrentProcessOwner = createCurrentProcessOwnerLookup(params);
  const updatedBeforeMs = asFiniteNumber(params.updatedBeforeMs);

  const orphanChecks: Array<() => boolean> = [];
  const queued: Array<{ entry: SessionEntry; sessionKey: string }> = [];
  const result = await markRecoveryStore({
    ...params.target,

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
      if (
        entry.mainRestartRecovery?.queuedInputsPending &&
        ((!isCapturedMainRestartTurnCurrent(entry) && !hasMainSessionRecoveryClaim(entry)) ||
          (entry.abortedLastRun === true &&
            entry.mainRestartRecovery.queuedInputId &&
            entry.mainRestartRecovery.turnIntent &&
            entry.mainRestartRecovery.queuedInputId !==
              entry.mainRestartRecovery.turnIntent.inputId)) &&
        !hasCurrentProcessOwner(entry, sessionKey)
      ) {
        queued.push({ entry, sessionKey });
        return undefined;
      }
      if (!isMainSessionRecoveryIntentCurrent(entry)) {
        return undefined;
      }
      if (
        !hasMainSessionRecoveryClaim(entry) &&
        !isMainSessionRecoveryReconciliationCandidate(entry) &&
        !isCapturedMainRestartGoalCurrent(entry) &&
        !isCapturedMainRestartTurnCurrent(entry)
      ) {
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
        hasCurrentProcessOwner(entry, sessionKey);
      if (hasLiveOwner()) {
        return undefined;
      }
      const turn = entry.mainRestartRecovery?.turnIntent;
      const acceptedTurn =
        turn &&
        isCapturedMainRestartTurnCurrent(entry) &&
        turn.sessionKey === sessionKey &&
        turn.lifecycleRevision === entry.lifecycleRevision
          ? turn
          : undefined;
      if (isCapturedMainRestartGoalCurrent(entry) || acceptedTurn) {
        orphanChecks.push(hasLiveOwner);
        return {
          action: "mark",
          resetRuntime: entry.lifecycleRunId === undefined,
          ...(acceptedTurn
            ? {
                replaceRuns: true,
                runs: [
                  {
                    runId: acceptedTurn.runId,
                    lifecycleGeneration: acceptedTurn.lifecycleGeneration,
                  },
                ],
              }
            : {}),
        };
      }
      const continuation = captureYieldedMainSessionContinuation({
        storeAgentId: params.target.agentId,
        cfg: params.cfg,
        entry,
        sessionKey,
        storePath: params.target.storePath,
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
      if (entry.abortedLastRun === true) {
        return undefined;
      }
      orphanChecks.push(hasLiveOwner);
      return isMainRestartRecoveryTerminalOnly(entry)
        ? { action: "retire_terminal" }
        : { action: "mark", resetRuntime: entry.lifecycleRunId === undefined };
    },
  });
  for (const candidate of queued) {
    const promoted = await promoteQueuedMainSessionInput(
      { ...params.target, sessionKey: candidate.sessionKey },
      candidate.entry,
      () => {
        params.assertCommitAllowed?.();
        if (
          hasCurrentProcessOwner(candidate.entry, candidate.sessionKey) ||
          listAgentRunsForSession({
            sessionKey: candidate.sessionKey,
            sessionId: candidate.entry.sessionId,
          }).some(({ runId }) => hasLiveAgentRunContext(runId))
        ) {
          throw new Error("Queued recovery acquired a current execution owner");
        }
      },
    );
    if (promoted) {
      result.marked += 1;
    }
  }
  return result;
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
  agentIds?: ReadonlySet<string>;
  cfg?: OpenClawConfig;
  stateDir?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  startupCheckedStorePaths?: Set<string>;
  updatedBeforeMs?: number;
}): Promise<{ marked: number; skipped: number; failedTargets?: RestartRecoveryStoreTarget[] }> {
  const result = { marked: 0, skipped: 0 };
  const failedTargets: RestartRecoveryStoreTarget[] = [];
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const storeTargets = await discoverRestartRecoveryStoreTargets({
    ...params,
  });
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
      recordStartupRecoveryStoreResult({ target, lifecycleGeneration, outcome: { ok: true } });
    } catch (error) {
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
      failedTargets.push(target);
      recordStartupRecoveryStoreResult({
        target,
        lifecycleGeneration,
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
