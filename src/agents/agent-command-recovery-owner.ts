import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AgentCommandOpts } from "./command/types.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import {
  claimMainSessionRecoveryOwner,
  inspectMainSessionRecoveryRequired,
  releaseMainSessionRecoveryOwner,
  validateMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
  type MainSessionRecoveryPendingTarget,
} from "./main-session-recovery-store.js";

const log = createSubsystemLogger("agents/agent-command");

type PreparedRecoveryOwnerTarget = object & {
  isNewSession: boolean;
  previousSessionId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath: string;
  runLease?: { release: () => Promise<void> };
};

async function claimAgentCommandRecoveryOwner(params: {
  lifecycleGeneration: string;
  mode: "claim" | "reject_uncoordinated";
  opts: AgentCommandOpts;
  prepared: PreparedRecoveryOwnerTarget;
}): Promise<MainSessionRecoveryOwnerLease | undefined> {
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
      path.resolve(transferredLease.storePath) === path.resolve(params.prepared.storePath);
    if (!matchesPreparedTarget || !(await validateMainSessionRecoveryOwner(transferredLease))) {
      // Gateway transfers a persisted fence before preparation; bind it again after
      // session resolution so rollover or rerouting cannot execute under another row's lease.
      throw new Error("main-session recovery owner changed during ingress preparation; retry");
    }
    return transferredLease;
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
  if (params.mode === "reject_uncoordinated") {
    const recoveryInspection = await inspectMainSessionRecoveryRequired({
      allowMissingSession:
        (params.prepared.isNewSession && !params.prepared.previousSessionId) ||
        params.opts.sessionId?.trim() === params.prepared.sessionId,
      expectedSessionId: params.prepared.previousSessionId ?? params.prepared.sessionId,
      lifecycleGeneration: params.lifecycleGeneration,
      target: { sessionKey, storePath: params.prepared.storePath },
    });
    if (recoveryInspection.kind === "invalidated") {
      throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
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
    target: { sessionKey, storePath: params.prepared.storePath },
  });
  if (claim.kind === "invalidated") {
    throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
  }
  if (claim.kind === "not_required") {
    return undefined;
  }
  // Explicit replacements keep this token through successor persistence so
  // recovery cannot race the replacement; Gateway claims follow the same lease path.
  return claim.lease;
}

export async function runWithAgentCommandRecoveryOwner<
  TPrepared extends PreparedRecoveryOwnerTarget,
  TResult,
>(params: {
  lifecycleGeneration: string;
  mode: "claim" | "reject_uncoordinated";
  opts: AgentCommandOpts;
  prepare: (opts: AgentCommandOpts) => Promise<TPrepared>;
  restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
  run: (prepared: TPrepared) => Promise<TResult>;
}): Promise<TResult> {
  // Gateway may preclaim before dispatch, so every preparation outcome must release ownership.
  let lease = params.opts.mainRestartRecoveryOwnerLease;
  let pendingRecovery: Awaited<ReturnType<typeof releaseMainSessionRecoveryOwner>> = undefined;
  let prepared: TPrepared | undefined;
  try {
    try {
      prepared = await params.prepare(params.opts);
    } catch (error) {
      // Gateway admission consumes the durable reservation before command
      // preparation. Restore it when preparation fails before a run exists.
      pendingRecovery = await params.restoreAdmittedRecovery?.();
      throw error;
    }
    lease = await claimAgentCommandRecoveryOwner({ ...params, prepared });
    return await params.run(prepared);
  } finally {
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
  }
}
