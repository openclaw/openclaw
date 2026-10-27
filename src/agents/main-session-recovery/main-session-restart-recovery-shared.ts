import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../../config/paths.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveSessionStorePathCore,
  type InternalSessionEntry as SessionEntry,
  type SessionStoreTarget,
} from "../../config/sessions.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import { prepareSessionStoreTargetInventory } from "../../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../../config/sessions/session-store-target-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../../routing/session-key.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import { resolveAgentSessionDirs } from "../session-dirs.js";

export const mainSessionRecoveryLog = createSubsystemLogger("main-session-restart-recovery");
export const DEFAULT_RECOVERY_DELAY_MS = 5_000;
export const MAX_RECOVERY_RETRIES = 3;
export const RETRY_BACKOFF_MULTIPLIER = 2;
/** Mailbox identity of one resend attempt; its dispatcher and foreground admission both derive it. */
export function resolveRestartResendReservationId(attempt: {
  sessionId: string;
  cycleId: string;
  attempt: number;
}): string {
  return `main-session-recovery:${attempt.sessionId}:${attempt.cycleId}:${attempt.attempt}`;
}

export function readInterruptedRunId(entry: SessionEntry): string | undefined {
  const runs = entry.restartRecoveryRuns;
  if (!runs?.length) {
    return normalizeOptionalString(entry.lifecycleRunId);
  }
  return runs.length === 1 ? runs[0]?.runId : undefined;
}

export type ExpectedRestartRecoveryTarget = {
  agentId?: string;
  canonicalSessionKey?: string;
  sessionId: string;
  sessionKey: string;
  claim?: { runId: string; sourceRunId: string };
};

export type ExhaustedRestartRecoveryTarget = ExpectedRestartRecoveryTarget & {
  storePath: string;
};

export function resolveRestartRecoveryTerminalClientRunId(
  entry: Pick<SessionEntry, "restartRecoveryDeliverySourceRunId" | "restartRecoverySourceIngress">,
): string | undefined {
  return entry.restartRecoverySourceIngress === "control-ui" ||
    entry.restartRecoverySourceIngress === "internal"
    ? normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId)
    : undefined;
}

export async function discoverRestartRecoveryStoreTargets(params: {
  cfg?: OpenClawConfig;
  agentIds?: ReadonlySet<string>;
  stateDir?: string;
  shouldContinue?: () => boolean;
}): Promise<SessionStoreTarget[]> {
  if (params.shouldContinue?.() === false) {
    return [];
  }
  const storeTargets: SessionStoreTarget[] = [];
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  if (params.cfg) {
    // Recovery must not reopen a deleted or otherwise unconfigured agent database merely
    // because its old directory still exists on disk. Those stores are intentionally fenced
    // by the deletion journal, and stale auth-probe directories are not agent roster entries.
    const configuredAgentIds = listConfiguredSessionStoreAgentIds(params.cfg);
    const selectedAgentIds = configuredAgentIds.filter(
      (agentId) => !params.agentIds || params.agentIds.has(agentId),
    );
    const configuredStorePaths = new Set(
      configuredAgentIds.map((agentId) =>
        path.resolve(resolveSessionStorePathCore(params.cfg?.session?.store, { agentId, env })),
      ),
    );
    const configuredAgentIdSet = new Set(configuredAgentIds);
    const inventory = prepareSessionStoreTargetInventoryRead(
      prepareSessionStoreTargetInventory(
        params.cfg,
        isPerAgentSessionStoreConfig(params.cfg.session?.store)
          ? selectedAgentIds
          : [...new Set([...configuredAgentIds, ...(params.agentIds ?? [])])],
        env,
        "recovery",
      ),
    );
    const targets = await inventory.withRead(async (snapshot) =>
      snapshot.agents.flatMap(({ result }) => (result.available ? result.targets : [])),
    );
    if (params.shouldContinue?.() === false) {
      return [];
    }
    for (const target of targets) {
      const storePath = path.resolve(target.storePath);
      // Fixed configured stores can retain a durable owner whose ID differs from the
      // current roster entry. The validated path is the configuration fact; the target's
      // owner label is not evidence that the path itself is unconfigured.
      if (!configuredAgentIdSet.has(target.agentId) && !configuredStorePaths.has(storePath)) {
        continue;
      }
      if (params.agentIds && !params.agentIds.has(target.agentId)) {
        continue;
      }
      storeTargets.push({ ...target, storePath });
    }
  } else {
    for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) {
      const storePath = path.join(sessionsDir, "sessions.json");
      storeTargets.push({
        agentId:
          resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath).agentId ??
          LEGACY_IMPLICIT_AGENT_ID,
        storePath,
      });
    }
  }
  if (params.shouldContinue?.() === false) {
    return [];
  }
  return storeTargets
    .filter(
      (target) =>
        (params.cfg !== undefined || !params.agentIds || params.agentIds.has(target.agentId)) &&
        !readAgentDatabaseAdmissionRefusal(target.agentId, { env }),
    )
    .toSorted(
      (a, b) => a.storePath.localeCompare(b.storePath) || a.agentId.localeCompare(b.agentId),
    );
}

export async function runRecoveryRetries(params: {
  initialDelayMs: number;
  maxRetries: number;
  retryDelayMs?: number;
  shouldContinue: () => boolean;
  signal?: AbortSignal;
  attempt: (finalAttempt: boolean) => Promise<boolean>;
  onError: (error: unknown, finalAttempt: boolean) => void | Promise<void>;
}): Promise<void> {
  let delayMs = params.initialDelayMs;
  for (let attempt = 1; attempt <= params.maxRetries && params.shouldContinue(); attempt += 1) {
    const finalAttempt = attempt === params.maxRetries;
    try {
      if (delayMs > 0) {
        await sleepWithAbort(delayMs, params.signal, { ref: false });
      }
      if (!params.shouldContinue() || (await params.attempt(finalAttempt))) {
        return;
      }
    } catch (error) {
      if (!params.shouldContinue()) {
        return;
      }
      await params.onError(error, finalAttempt);
      if (finalAttempt) {
        return;
      }
    }
    delayMs =
      delayMs > 0
        ? delayMs * RETRY_BACKOFF_MULTIPLIER
        : (params.retryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS);
  }
}
