import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveSessionStoreCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  type InternalSessionEntry,
  type InternalSessionEntry as SessionEntry,
  type RestartRecoveryRun,
  resolveAllAgentSessionStoreTargetsSync,
} from "../../config/sessions.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import {
  listDurableSqliteTargetOwnersForSessionStorePath,
  resolveSqliteTargetFromSessionStorePath,
} from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewaySessionStoreTarget } from "../../gateway/session-utils.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { listAgentRunsForSession } from "../../infra/agent-run-registry.js";
import { LEGACY_IMPLICIT_AGENT_ID, parseAgentSessionKey } from "../../routing/session-key.js";
import { appendInterruptedSessionTrajectoryEndSync } from "../../trajectory/interrupted-end.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "../embedded-agent-runner/run-state.js";
import { resolveAgentSessionDirs } from "../session-dirs.js";
import {
  isMainRestartRecoveryAggregateTerminalOnly,
  isMainRestartRecoveryCandidate,
  normalizeMainSessionRecoveryRunFences,
  transitionMainSessionRecovery,
} from "./main-session-recovery-state.js";
import {
  hasCurrentProcessOwner,
  mainSessionRecoveryLog,
  normalizeFiniteTimestamp,
  normalizeStringSet,
  resolveRestartRecoveryStorePaths,
} from "./main-session-restart-recovery-shared.js";

function resolveInterruptedSessionOwner(params: {
  cfg: OpenClawConfig | undefined;
  sessionKey: string;
}): string | undefined {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  // Global and legacy-alias keys in a fixed store are owned by the configured
  // compatibility agent (an explicit persisted owner or the legacy default).
  // Without config the store writer resolves those rows to the legacy implicit
  // owner. Agent-scoped keys already returned above, so this only applies to
  // unscoped keys.
  if (params.cfg) {
    return resolveSessionStoreCompatibilityAgentId(params.cfg);
  }
  return LEGACY_IMPLICIT_AGENT_ID;
}

async function markRecoveryStore(params: {
  storePath: string;
  statuses?: Array<NonNullable<SessionEntry["status"]>>;
  cfg?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  trajectoryReason?: string;
  plan: (
    entry: SessionEntry,
    sessionKey: string,
  ) =>
    | { action: "mark"; replaceRuns?: boolean; resetRuntime?: boolean; runs?: RestartRecoveryRun[] }
    | { action: "retire_terminal" }
    | undefined;
}) {
  // Fixed stores may partition rows across per-agent SQLite siblings. Scan each
  // durable owner so global/legacy-alias keys under an explicit compatibility
  // agent are processed in their own database, not silently dropped by the
  // default-owner resolution.
  const owners = listDurableSqliteTargetOwnersForSessionStorePath(params.storePath);
  const agentIdsToScan = owners.length > 0 ? owners : [undefined];
  const aggregated = { marked: 0, skipped: 0 };
  for (const ownerAgentId of agentIdsToScan) {
    // Resolve the trajectory database target for this owner partition before
    // opening the session write transaction so filesystem/registry inspection
    // does not run while the session lock is held.
    const trajectoryTarget = resolveSqliteTargetFromSessionStorePath(
      params.storePath,
      ownerAgentId ? { agentId: ownerAgentId } : {},
    );
    const markedSessions: Array<{
      sessionKey: string;
      sessionId: string;
      runId?: string;
      agentId?: string;
    }> = [];
    const groupResult = await applySessionEntryReplacements<{ marked: number; skipped: number }>({
      storePath: params.storePath,
      statuses: params.statuses,
      requireWriteSuccess: true,
      ...(ownerAgentId ? { agentId: ownerAgentId } : {}),
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
          // SAFETY: replacement snapshots are persisted InternalSessionEntry rows containing the internal lifecycleRunId field.
          const interruptedRunId = (entry as InternalSessionEntry).lifecycleRunId;
          // The row was just committed in this scan's durable owner partition
          // (or the store's default-owner pass when no partition is recorded),
          // so the scanned owner is the authoritative trajectory owner; key and
          // config resolution only covers the unscanned default-owner pass.
          const sessionOwnerAgentId =
            ownerAgentId ?? resolveInterruptedSessionOwner({ cfg: params.cfg, sessionKey });
          if (plan.replaceRuns) {
            entry.restartRecoveryRuns = plan.runs;
          }
          transitionMainSessionRecovery(entry, {
            kind: "mark_interrupted",
            cycleId: randomUUID(),
            now: Date.now(),
            ...plan,
          });
          replacements.push({ sessionKey, entry });
          markedSessions.push({
            sessionKey,
            sessionId: entry.sessionId,
            runId: interruptedRunId,
            agentId: sessionOwnerAgentId,
          });
          counts.marked++;
        }
        return { result: counts, replacements };
      },
      afterWriteInTransaction: () => {
        for (const marked of markedSessions) {
          appendInterruptedSessionTrajectoryEndSync({
            agentDatabaseAgentId: trajectoryTarget.agentId ?? marked.agentId,
            agentDatabasePath: trajectoryTarget.path,
            env: params.env,
            runId: marked.runId,
            sessionKey: marked.sessionKey,
            sessionId: marked.sessionId,
            storePath: params.storePath,
            reason: params.trajectoryReason,
          });
        }
      },
    });
    aggregated.marked += groupResult.marked;
    aggregated.skipped += groupResult.skipped;
  }
  return aggregated;
}

export async function markRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  additionalCfgs?: Iterable<OpenClawConfig | undefined>;
  stateDir?: string;
  sessionKeys?: Iterable<string>;
  sessionIds?: Iterable<string>;
  activeRuns?: Iterable<
    RestartRecoveryRun & {
      sessionKey: string;
      sessionId: string;
      observedAt?: number;
    }
  >;
  isActiveRun?: (
    run: RestartRecoveryRun & {
      sessionKey: string;
      sessionId: string;
      observedAt?: number;
    },
  ) => boolean;
  reason?: string;
}): Promise<{ marked: number; skipped: number }> {
  const sessionKeys = normalizeStringSet(params.sessionKeys);
  const sessionIds = normalizeStringSet(params.sessionIds);
  const preferSessionIdMatch = sessionIds.size > 0;
  const activeRuns = [...(params.activeRuns ?? [])]
    .map((run) => ({
      runId: run.runId.trim(),
      lifecycleGeneration: run.lifecycleGeneration.trim(),
      sessionKey: run.sessionKey.trim(),
      sessionId: run.sessionId.trim(),
      observedAt: normalizeFiniteTimestamp(run.observedAt),
    }))
    .filter((run) => run.runId && run.lifecycleGeneration && (run.sessionKey || run.sessionId));
  const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
  const result = { marked: 0, skipped: 0 };
  if (sessionKeys.size === 0 && sessionIds.size === 0) {
    return result;
  }

  const storePaths = new Set<string>();
  const env =
    params.stateDir === undefined
      ? process.env
      : { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const stateDir = resolveStateDir(env);
  const configs = [params.cfg, ...(params.additionalCfgs ?? [])].filter(
    (cfg): cfg is OpenClawConfig => Boolean(cfg),
  );
  for (const cfg of configs) {
    try {
      for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
        storePaths.add(path.resolve(target.storePath));
      }
    } catch (err) {
      mainSessionRecoveryLog.warn(
        `failed to resolve configured session stores for restart marker: ${String(err)}`,
      );
    }
    for (const sessionKey of preferSessionIdMatch ? [] : sessionKeys) {
      try {
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key: sessionKey,
        });
        storePaths.add(path.resolve(target.storePath));
        for (const storeKey of target.storeKeys) {
          const trimmed = storeKey.trim();
          if (trimmed) {
            sessionKeys.add(trimmed);
          }
        }
      } catch (err) {
        mainSessionRecoveryLog.warn(
          `failed to resolve session store for restart marker ${sessionKey}: ${String(err)}`,
        );
      }
    }
  }

  for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) {
    storePaths.add(path.join(sessionsDir, "sessions.json"));
  }

  for (const storePath of storePaths) {
    const storeResult = await markRecoveryStore({
      storePath,
      cfg: params.cfg,
      env,
      trajectoryReason: params.reason,
      plan: (entry, sessionKey) => {
        const registeredActiveRuns = listAgentRunsForSession({
          sessionKey,
          sessionId: entry.sessionId,
        });
        const matchingActiveRuns = activeRuns.filter(
          (run) =>
            (run.sessionId ? run.sessionId === entry.sessionId : run.sessionKey === sessionKey) &&
            (entry.status === "running" ||
              run.observedAt === undefined ||
              normalizeFiniteTimestamp(entry.updatedAt) === undefined ||
              (entry.updatedAt < run.observedAt &&
                run.lifecycleGeneration !== currentLifecycleGeneration)) &&
            params.isActiveRun?.(run) !== false,
        );
        if (
          entry.status !== "running" &&
          matchingActiveRuns.length === 0 &&
          registeredActiveRuns.length === 0
        ) {
          return undefined;
        }
        const matches =
          typeof entry.sessionId === "string" && sessionIds.has(entry.sessionId)
            ? true
            : !preferSessionIdMatch && sessionKeys.has(sessionKey);
        if (!matches) {
          return undefined;
        }
        const wasRunning = entry.status === "running";
        const runs = normalizeMainSessionRecoveryRunFences([
          ...(entry.restartRecoveryRuns ?? []).filter(
            (run) => run.lifecycleGeneration === currentLifecycleGeneration,
          ),
          ...registeredActiveRuns,
          ...matchingActiveRuns.map(({ runId, lifecycleGeneration }) => ({
            runId,
            lifecycleGeneration,
          })),
        ]);
        return { action: "mark", replaceRuns: true, resetRuntime: !wasRunning, runs };
      },
    });
    result.marked += storeResult.marked;
    result.skipped += storeResult.skipped;
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

export async function markStartupOrphanedMainSessionsForRecovery(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  startupCheckedStorePaths?: Set<string>;
  updatedBeforeMs?: number;
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const providedActiveSessionIds =
    params.activeSessionIds === undefined ? undefined : normalizeStringSet(params.activeSessionIds);
  const providedActiveSessionKeys =
    params.activeSessionKeys === undefined
      ? undefined
      : normalizeStringSet(params.activeSessionKeys);
  const updatedBeforeMs = normalizeFiniteTimestamp(params.updatedBeforeMs);
  // Lifecycle rotation synchronously evicts stale owners, so this same registry
  // view drives both operational routing and recovery suppression. Re-read it at
  // each check so a newer owner can still fence an older async recovery scan.
  const resolveActiveSessionIds = () =>
    providedActiveSessionIds ?? normalizeStringSet(listActiveEmbeddedRunSessionIds());
  const resolveActiveSessionKeys = () =>
    providedActiveSessionKeys ?? normalizeStringSet(listActiveEmbeddedRunSessionKeys());
  const env =
    params.stateDir === undefined
      ? process.env
      : { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };

  // Check each store path once at startup so rows added later in that same path remain current.
  // Add paths only after every marking write succeeds so a failed scan retries safely.
  const storePaths = (await resolveRestartRecoveryStorePaths(params)).filter(
    (storePath) => !params.startupCheckedStorePaths?.has(storePath),
  );
  for (const storePath of storePaths) {
    const storeResult = await markRecoveryStore({
      storePath,
      statuses: ["running"],
      cfg: params.cfg,
      env,
      plan: (entry, sessionKey) => {
        if (entry.status !== "running" || entry.abortedLastRun === true) {
          return undefined;
        }
        const updatedAt = normalizeFiniteTimestamp(entry.updatedAt);
        if (
          updatedBeforeMs !== undefined &&
          updatedAt !== undefined &&
          updatedAt > updatedBeforeMs
        ) {
          return undefined;
        }
        if (
          hasCurrentProcessOwner({
            activeSessionIds: resolveActiveSessionIds(),
            activeSessionKeys: resolveActiveSessionKeys(),
            entry,
            sessionKey,
          })
        ) {
          return undefined;
        }
        return isMainRestartRecoveryAggregateTerminalOnly(entry)
          ? { action: "retire_terminal" }
          : { action: "mark" };
      },
    });
    result.marked += storeResult.marked;
    result.skipped += storeResult.skipped;
  }
  storePaths.forEach((storePath) => params.startupCheckedStorePaths?.add(storePath));

  if (result.marked > 0) {
    mainSessionRecoveryLog.warn(
      `marked ${result.marked} startup-orphaned main session(s) for restart recovery`,
    );
  }
  return result;
}
