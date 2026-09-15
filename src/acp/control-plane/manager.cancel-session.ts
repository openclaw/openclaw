/** Cancellation path for active ACP turns and idle runtime handles. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import type { AcceptedTurnState, AcceptedTurns } from "./manager.accepted-turns.js";
import type {
  ActiveTurnState,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  SetManagerSessionState,
  WithManagerSessionActor,
} from "./manager.types.js";
import { acpSessionActorKey, requireReadySessionMeta } from "./manager.utils.js";

/** Cancels either the active ACP turn or the idle runtime handle for a session. */
export async function runManagerCancelSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  reason?: string;
  expectedRunId?: string;
  expectedInstanceId?: string;
  expectedOwnerKey?: string;
  activeTurnBySession: Map<string, ActiveTurnState>;
  acceptedTurns: AcceptedTurns;
  withSessionActor: WithManagerSessionActor;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  setSessionState: SetManagerSessionState;
}): Promise<void> {
  const actorKey = acpSessionActorKey(params);
  const expectedRunId = params.expectedRunId?.trim();
  const expectedInstanceId = params.expectedInstanceId?.trim();
  const expectedOwnerKey = params.expectedOwnerKey?.trim();
  const requireExpectedTurn = (current: ActiveTurnState | undefined) => {
    if (
      (expectedRunId && current?.requestId !== expectedRunId) ||
      (expectedInstanceId && current?.instanceId !== expectedInstanceId)
    ) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP task is no longer the active run.");
    }
  };
  const requireExpectedOwner = () => {
    if (!expectedOwnerKey) {
      return;
    }
    const resolution = params.resolveSession(params);
    const entry = resolution.kind === "ready" ? resolution.entry : undefined;
    const ownerKey = entry?.spawnedBy?.trim() || entry?.parentSessionKey?.trim();
    if (ownerKey !== expectedOwnerKey) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP task owner could not be verified.");
    }
  };
  // Snapshot accepted instances before yielding: a later successor is never cancelled.
  const accepted = [...(params.acceptedTurns.get(actorKey) ?? [])].filter(
    (turn) =>
      (!expectedRunId || turn.requestId === expectedRunId) &&
      (!expectedInstanceId || turn.instanceId === expectedInstanceId),
  );
  if (accepted.length > 0) {
    requireExpectedOwner();
    await Promise.all(
      accepted.map((acceptedTurn) =>
        cancelManagerAcceptedTurn({
          acceptedTurn,
          reason: params.reason,
          revalidate: requireExpectedOwner,
        }),
      ),
    );
    return;
  }
  requireExpectedTurn(undefined);

  await params.withSessionActor(params, async () => {
    // The actor wait may admit queued work. Recheck exact authority only after
    // that wait, immediately before the idle-handle cancellation boundary.
    requireExpectedTurn(params.activeTurnBySession.get(actorKey));
    requireExpectedOwner();
    const resolution = params.resolveSession({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    const resolvedMeta = requireReadySessionMeta(resolution);
    const { runtime, handle } = await params.ensureRuntimeHandle({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      meta: resolvedMeta,
    });
    try {
      requireExpectedOwner();
      await runtime.cancel({
        handle,
        reason: params.reason,
      });
      await params.setSessionState({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        state: "idle",
        clearLastError: true,
      });
    } catch (error) {
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP cancel failed before completion.",
      });
      await params.setSessionState({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        state: "error",
        lastError: acpError.message,
      });
      throw acpError;
    }
  });
}

/** Aborts and deduplicates runtime cancellation for one active manager turn. */
export async function cancelManagerActiveTurn(params: {
  activeTurn: ActiveTurnState;
  reason?: string;
  revalidate?: () => void;
}): Promise<void> {
  params.revalidate?.();
  params.activeTurn.abortController.abort();
  if (!params.activeTurn.cancelPromise) {
    params.activeTurn.cancelPromise = params.activeTurn.runtime.cancel({
      handle: params.activeTurn.handle,
      reason: params.reason,
    });
  }
  await withAcpRuntimeErrorBoundary({
    run: async () => await params.activeTurn.cancelPromise!,
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP cancel failed before completion.",
  });
}

/** Cancellation retains setup custody until a late handle and its turn settle. */
export async function cancelManagerAcceptedTurn(params: {
  acceptedTurn: AcceptedTurnState;
  reason?: string;
  revalidate?: () => void;
}): Promise<void> {
  params.revalidate?.();
  const turn = params.acceptedTurn;
  turn.cancelReason ??= params.reason;
  turn.revalidateCancel ??= params.revalidate;
  turn.abortController.abort();
  if (turn.activeTurn) {
    await cancelManagerActiveTurn({
      activeTurn: turn.activeTurn,
      reason: turn.cancelReason,
      revalidate: turn.revalidateCancel,
    });
  } else {
    await turn.settled;
  }
}
