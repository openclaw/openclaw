import path from "node:path";
import type { InternalSessionEntry } from "../config/sessions.js";
import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import { hasRestartRecoveryTerminalRun } from "../config/sessions/restart-recovery-state.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import type { AgentCommandOpts } from "./command/types.js";
import { repairMainSessionRecoveryMutation } from "./main-session-recovery/main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery/main-session-recovery-owner-release.js";
import {
  claimMainSessionRecoveryOwner,
  inspectMainSessionRecoveryRequired,
  refreshMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
  type MainSessionRecoveryPendingTarget,
} from "./main-session-recovery/main-session-recovery-store.js";

const log = createSubsystemLogger("agents/agent-command");

type PreparedRecoveryOwnerTarget = {
  sessionAgentId: string;
  isNewSession: boolean;
  previousSessionId?: string;
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: InternalSessionEntry;
  sessionStore?: Record<string, InternalSessionEntry>;
  storePath: string;
  runLease?: { release: () => Promise<void> };
  opts?: AgentCommandOpts;
};

type AcquiredRecoveryOwner = {
  lease?: MainSessionRecoveryOwnerLease;
  entry: InternalSessionEntry;
  sessionKey: string;
};

function refreshPreparedRecoveryOwnerTarget(
  prepared: PreparedRecoveryOwnerTarget,
  acquired: AcquiredRecoveryOwner | undefined,
): void {
  if (!acquired || acquired.entry.sessionId !== prepared.sessionId) {
    return;
  }
  const entry = acquired.entry;
  prepared.sessionEntry = entry;
  if (prepared.sessionStore && prepared.sessionKey) {
    prepared.sessionStore[prepared.sessionKey] = entry;
  }
}

async function claimAgentCommandRecoveryOwner(params: {
  lifecycleGeneration: string;
  mode: "claim" | "reject_uncoordinated";
  opts: AgentCommandOpts;
  prepared: PreparedRecoveryOwnerTarget;
}): Promise<AcquiredRecoveryOwner | undefined> {
  const transferredLease = params.opts.mainRestartRecoveryOwnerLease;
  if (transferredLease) {
    const expectedLeaseSessionId = params.prepared.isNewSession
      ? params.prepared.previousSessionId
      : params.prepared.sessionId;
    const matchesPreparedTarget =
      expectedLeaseSessionId !== undefined &&
      transferredLease.lifecycleGeneration === params.lifecycleGeneration &&
      transferredLease.sessionId === expectedLeaseSessionId &&
      transferredLease.sessionKey === params.prepared.sessionKey &&
      (transferredLease.agentId === undefined ||
        transferredLease.agentId === params.prepared.sessionAgentId) &&
      path.resolve(transferredLease.storePath) === path.resolve(params.prepared.storePath);
    // Bind the transferred fence again after preparation before refreshing its durable owner.
    const snapshot = matchesPreparedTarget
      ? await refreshMainSessionRecoveryOwner(transferredLease, params.opts.runId)
      : undefined;
    if (!snapshot) {
      throw new Error("main-session recovery owner changed during ingress preparation; retry");
    }
    return snapshot;
  }
  if (params.opts.sessionEffects === "internal") {
    return undefined;
  }
  if (params.opts.mainRestartRecoveryAdmitted === true) {
    return undefined;
  }
  const sessionKey = params.prepared.sessionKey;
  if (!sessionKey) {
    return undefined;
  }
  const target = {
    agentId: params.prepared.sessionAgentId,
    sessionKey,
    storePath: params.prepared.storePath,
  };
  if (params.mode === "reject_uncoordinated") {
    const recoveryInspection = await inspectMainSessionRecoveryRequired({
      allowMissingSession:
        (params.prepared.isNewSession && !params.prepared.previousSessionId) ||
        params.opts.sessionId?.trim() === params.prepared.sessionId,
      expectedSessionId: params.prepared.previousSessionId ?? params.prepared.sessionId,
      lifecycleGeneration: params.lifecycleGeneration,
      target,
    });
    if (recoveryInspection.kind === "invalidated") {
      throw createSessionWorkStartChangedError(sessionKey);
    }
    if (recoveryInspection.kind === "required") {
      throw new Error(
        `Session "${sessionKey}" has interrupted work pending restart recovery; retry through a healthy Gateway or reset it there with /new or /reset.`,
      );
    }
    return undefined;
  }
  // Claim against the latest durable row instead of the preparation snapshot.
  // A restart marker may appear or clear while preparation reads the session.
  const claim = await claimMainSessionRecoveryOwner({
    allowMissingSession:
      (params.prepared.isNewSession && !params.prepared.previousSessionId) ||
      params.opts.sessionId?.trim() === params.prepared.sessionId,
    lifecycleGeneration: params.lifecycleGeneration,
    sessionId: params.prepared.previousSessionId ?? params.prepared.sessionId,
    replacementSessionId: params.prepared.isNewSession ? params.prepared.sessionId : undefined,
    runId: params.opts.runId,
    target,
  });
  if (claim.kind === "invalidated") {
    throw createSessionWorkStartChangedError(sessionKey);
  }
  if (claim.kind === "not_required") {
    if (
      params.opts.runId &&
      ["subagent_settle", "subagent_announce"].includes(
        params.opts.inputProvenance?.sourceTool ?? "",
      ) &&
      hasRestartRecoveryTerminalRun(claim.entry, params.opts.runId)
    ) {
      throw createSessionWorkStartChangedError(sessionKey);
    }
    return claim.entry && claim.sessionKey
      ? { entry: claim.entry, sessionKey: claim.sessionKey }
      : undefined;
  }
  // Explicit replacements keep this token through successor persistence so
  // recovery cannot race the replacement; Gateway claims follow the same lease path.
  return { lease: claim.lease, entry: claim.entry, sessionKey: claim.sessionKey };
}

export async function runWithAgentCommandRecoveryOwner<
  TPrepared extends PreparedRecoveryOwnerTarget,
  TResult,
>(options: {
  lifecycleGeneration: string;
  mode: "claim" | "reject_uncoordinated";
  opts: AgentCommandOpts;
  prepare: (opts: AgentCommandOpts) => Promise<TPrepared>;
  restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
  run: (prepared: TPrepared) => Promise<TResult>;
}): Promise<TResult> {
  const params = { ...options, opts: { ...options.opts } };
  const assertCurrent = () => {
    params.opts.abortSignal?.throwIfAborted();
    assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
    params.opts.assertSourceCurrent?.();
    params.opts.operatorAuthority?.assertCurrent();
  };
  // Gateway may preclaim before dispatch, so every preparation outcome must release ownership.
  let lease = params.opts.mainRestartRecoveryOwnerLease;
  let pendingRecovery: Awaited<ReturnType<typeof releaseMainSessionRecoveryOwner>> = undefined;
  let prepared: TPrepared | undefined;
  let cleanupStarted = false;
  const cleanup = async () => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    try {
      const releasedRecovery = await releaseMainSessionRecoveryOwner(lease);
      pendingRecovery ??= releasedRecovery;
    } catch (error) {
      log.warn(`failed to release main-session recovery owner: ${formatErrorMessage(error)}`);
    }
    try {
      await prepared?.runLease?.release();
    } finally {
      scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
    }
  };
  try {
    try {
      prepared = await params.prepare(params.opts);
    } catch (error) {
      // Gateway admission consumes the durable reservation before command
      // preparation. Restore it when preparation fails before a run exists.
      const restoreAdmittedRecovery = params.restoreAdmittedRecovery;
      if (restoreAdmittedRecovery) {
        pendingRecovery = await repairMainSessionRecoveryMutation({
          mutation: restoreAdmittedRecovery,
          onError: (restoreError) =>
            log.warn(
              `failed to restore admitted recovery after command preparation: ${formatErrorMessage(restoreError)}`,
            ),
        });
      }
      throw error;
    }
    const target = prepared;
    return await withSessionTurn(
      {
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
        agentId: target.sessionAgentId,
        storePath: target.storePath,
        abortSignal: params.opts.abortSignal,
        detached: params.opts.sessionEffects === "internal",
      },
      async (_operation, abortSignal) => {
        params.opts = { ...params.opts, abortSignal };
        if (target.opts) {
          target.opts = { ...target.opts, abortSignal };
        }
        try {
          assertCurrent();
          const acquired = await claimAgentCommandRecoveryOwner({ ...params, prepared: target });
          lease = acquired?.lease;
          assertCurrent();
          // Carry the owner transaction's exact row into the admitted command.
          refreshPreparedRecoveryOwnerTarget(target, acquired);
          return await params.run(target);
        } finally {
          await cleanup();
        }
      },
    );
  } finally {
    await cleanup();
  }
}
