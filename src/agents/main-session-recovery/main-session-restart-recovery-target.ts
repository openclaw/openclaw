import path from "node:path";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionStoreIdentity } from "../../gateway/session-store-key.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  classifySessionKeyShape,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { listSubagentRunsForRequester } from "../subagents/registry/subagent-registry-read.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";

type RestartRecoveryDispatchParams = {
  agentId?: string;
  storeAgentId?: string;
  cfg?: OpenClawConfig;
  sessionKey: string;
  storePath: string;
};

type RestartRecoveryDispatchTarget = { agentId: string; sessionKey: string };

function resolveRestartRecoveryStoreAgentId(params: RestartRecoveryDispatchParams) {
  // Expected targets and discovered agent partitions carry their execution owner.
  // A shared SQLite store's schema owner must never override its logical session route.
  return (
    params.agentId ??
    (params.storeAgentId &&
    !resolveSqliteTargetFromSessionStorePath(params.storePath, { agentId: params.storeAgentId })
      .shared
      ? params.storeAgentId
      : undefined) ??
    (isPerAgentSessionStoreConfig(params.cfg?.session?.store) &&
    classifySessionKeyShape(params.sessionKey) === "legacy_or_alias"
      ? resolveUnsuffixedSqliteTargetFromSessionStorePath(params.storePath).agentId
      : undefined)
  );
}

/** An unconfigured writer already owns its physical store and only needs the logical route. */
export function resolveRestartRecoveryDispatchIdentity(
  params: Omit<RestartRecoveryDispatchParams, "cfg">,
): RestartRecoveryDispatchTarget {
  return {
    agentId:
      params.agentId ??
      resolveAgentIdFromSessionKey(
        params.sessionKey,
        resolveRestartRecoveryStoreAgentId(params) ?? LEGACY_IMPLICIT_AGENT_ID,
      ),
    sessionKey: params.sessionKey,
  };
}

export async function resolveRestartRecoveryDispatchTarget(
  params: RestartRecoveryDispatchParams,
): Promise<RestartRecoveryDispatchTarget | undefined> {
  if (!params.cfg) {
    return resolveRestartRecoveryDispatchIdentity(params);
  }
  const storeAgentId = resolveRestartRecoveryStoreAgentId(params);
  try {
    const target = resolveSessionStoreIdentity({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      ...(storeAgentId ? { agentId: storeAgentId } : {}),
    });
    return !params.cfg.session?.store ||
      path.resolve(
        resolveSessionStorePathCore(params.cfg.session.store, { agentId: target.agentId }),
      ) === path.resolve(params.storePath)
      ? { agentId: target.agentId, sessionKey: target.canonicalKey }
      : undefined;
  } catch (err) {
    mainSessionRecoveryLog.warn(
      `failed to resolve recovery store for ${params.sessionKey}: ${String(err)}`,
    );
    return undefined;
  }
}

/** Captures the durable continuation that a completed requester turn yielded to. */
export function captureYieldedMainSessionContinuation(params: {
  entry: SessionEntry;
  requester: RestartRecoveryDispatchTarget | undefined;
}): (() => boolean) | undefined {
  // A prepared final may not have reached its queue yet; main recovery still owns that debt.
  if (
    params.entry.status !== undefined ||
    params.entry.pendingFinalDelivery !== undefined ||
    asFiniteNumber(params.entry.endedAt) === undefined
  ) {
    return undefined;
  }
  const requester = params.requester;
  if (!requester) {
    return undefined;
  }
  const listRuns = () =>
    listSubagentRunsForRequester(requester.sessionKey, {
      requesterAgentId: requester.agentId,
    });
  const owner = listRuns().find(
    (run) =>
      !run.collect &&
      run.expectsCompletionMessage === true &&
      !run.requesterTurnRunId &&
      run.requesterSettleWake?.requesterYieldBatch === true &&
      run.requesterSettleWake.rearmGeneration !== undefined &&
      run.requesterSettleWake.batchRunIds?.includes(run.runId),
  );
  if (!owner) {
    return undefined;
  }
  // The wake is pending/dispatching debt; completion removes it even for an abandoned batch.
  // Child delivery alone does not settle the visible final owed by a yielded requester.
  const wake = owner.requesterSettleWake;
  const rearmGeneration = wake?.rearmGeneration;
  return () =>
    listRuns().includes(owner) &&
    !owner.requesterTurnRunId &&
    owner.requesterSettleWake === wake &&
    wake?.rearmGeneration === rearmGeneration;
}
