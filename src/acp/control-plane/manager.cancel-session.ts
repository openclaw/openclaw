/** Cancellation path for active ACP turns and idle runtime handles. */
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import type {
  AcpSessionCancelTarget,
  AcpSessionResolution,
  ActiveTurnState,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  SetManagerSessionState,
  WithManagerSessionActor,
} from "./manager.types.js";
import { normalizeActorKey, requireReadySessionMeta } from "./manager.utils.js";

/** Cancels either the active ACP turn or the idle runtime handle for a session. */
export async function runManagerCancelSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason?: string;
  /** Refuse to cancel any ACP session other than this exact authorized target. */
  expectedTarget?: AcpSessionCancelTarget;
  activeTurnBySession: Map<string, ActiveTurnState>;
  withSessionActor: WithManagerSessionActor;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  setSessionState: SetManagerSessionState;
}): Promise<boolean> {
  const actorKey = normalizeActorKey(params.sessionKey);
  const activeTurn = params.activeTurnBySession.get(actorKey);
  if (activeTurn) {
    if (
      !resolvedSessionMatchesExpected(params) ||
      !runtimeHandleMatchesExpected(activeTurn.handle, params.expectedTarget)
    ) {
      return false;
    }
    await cancelActiveTurn({
      activeTurn,
      reason: params.reason,
    });
    return true;
  }

  return await params.withSessionActor(params.sessionKey, async () => {
    const resolution = params.resolveSession({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!resolutionMatchesExpectedTarget(resolution, params.expectedTarget)) {
      return false;
    }
    const resolvedMeta = requireReadySessionMeta(resolution);
    const { runtime, handle } = await params.ensureRuntimeHandle({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      meta: resolvedMeta,
    });
    if (
      !runtimeHandleMatchesExpected(handle, params.expectedTarget) ||
      !resolvedSessionMatchesExpected(params)
    ) {
      return false;
    }
    try {
      await cancelRuntimeHandle({
        runtime,
        handle,
        reason: params.reason,
      });
      await params.setSessionState({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        state: "idle",
        clearLastError: true,
      });
    } catch (error) {
      const acpError = normalizeCancelError(error);
      await params.setSessionState({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        state: "error",
        lastError: acpError.message,
      });
      throw acpError;
    }
    return true;
  });
}

function resolvedSessionMatchesExpected(
  params: Pick<
    Parameters<typeof runManagerCancelSession>[0],
    "cfg" | "expectedTarget" | "resolveSession" | "sessionKey"
  >,
): boolean {
  const resolution = params.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  return resolutionMatchesExpectedTarget(resolution, params.expectedTarget);
}

function resolutionMatchesExpectedTarget(
  resolution: AcpSessionResolution,
  expected: AcpSessionCancelTarget | undefined,
): boolean {
  if (!expected) {
    return true;
  }
  if (
    resolution.kind !== "ready" ||
    resolution.entry?.sessionId !== expected.sessionId ||
    resolution.meta.backend !== expected.backend ||
    resolution.meta.agent !== expected.agent ||
    resolution.meta.runtimeSessionName !== expected.runtimeSessionName
  ) {
    return false;
  }
  const currentIdentity = resolution.meta.identity;
  if (!expected.identity || !currentIdentity) {
    return expected.identity === currentIdentity;
  }
  return (
    currentIdentity.state === expected.identity.state &&
    currentIdentity.acpxRecordId === expected.identity.acpxRecordId &&
    currentIdentity.acpxSessionId === expected.identity.acpxSessionId &&
    currentIdentity.agentSessionId === expected.identity.agentSessionId
  );
}

function runtimeHandleMatchesExpected(
  handle: AcpRuntimeHandle,
  expected: AcpSessionCancelTarget | undefined,
): boolean {
  return (
    !expected ||
    (handle.backend === expected.backend &&
      handle.runtimeSessionName === expected.runtimeSessionName)
  );
}

async function cancelActiveTurn(params: {
  activeTurn: ActiveTurnState;
  reason?: string;
}): Promise<void> {
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

async function cancelRuntimeHandle(params: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  reason?: string;
}): Promise<void> {
  await withAcpRuntimeErrorBoundary({
    run: async () =>
      await params.runtime.cancel({
        handle: params.handle,
        reason: params.reason,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP cancel failed before completion.",
  });
}

function normalizeCancelError(error: unknown): AcpRuntimeError {
  return toAcpRuntimeError({
    error,
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP cancel failed before completion.",
  });
}
