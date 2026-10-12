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
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../../routing/session-key.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import { resolveAgentSessionDirs } from "../session-dirs.js";

export const mainSessionRecoveryLog = createSubsystemLogger("main-session-restart-recovery");
export const DEFAULT_RECOVERY_DELAY_MS = 5_000;
export const MAX_RECOVERY_RETRIES = 3;
export const RETRY_BACKOFF_MULTIPLIER = 2;
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
