/** Reconciles ACP runtime identity observations back into persisted session metadata. */
import {
  createIdentityFromHandleEvent,
  createIdentityFromStatus,
  identityEquals,
  mergeSessionIdentity,
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { logVerbose } from "../../globals.js";
import { withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import { createSupersededActorError } from "./manager.runtime-handle-ensure.js";
import { isAcpOwnerRepairRequired } from "./manager.runtime-owner.js";
import type {
  AcpSessionTarget,
  ReconcileManagerRuntimeSessionIdentifiers,
  SessionAcpMeta,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import { hasLegacyAcpIdentityProjection } from "./manager.utils.js";

/** Reconciles runtime-reported session identifiers into persisted ACP session metadata. */
export async function reconcileManagerRuntimeSessionIdentifiers(
  params: Parameters<ReconcileManagerRuntimeSessionIdentifiers>[0] & {
    setCachedHandle: (target: AcpSessionTarget, handle: AcpRuntimeHandle) => void;
    writeSessionMeta: WriteManagerSessionMeta;
  },
): ReturnType<ReconcileManagerRuntimeSessionIdentifiers> {
  const isCurrentActor = params.isCurrentActor ?? (() => true);
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (!isCurrentActor()) {
      throw createSupersededActorError(params.sessionKey);
    }
  };
  const beforeControl = params.revalidateControl?.();
  let acpControl = beforeControl ? (await beforeControl) || undefined : undefined;
  assertCurrent();
  let runtimeStatus = params.runtimeStatus;
  if (!runtimeStatus && params.runtime.getStatus) {
    try {
      runtimeStatus = await withAcpRuntimeErrorBoundary({
        run: async () =>
          await params.runtime.getStatus!({
            handle: params.handle,
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not read ACP runtime status.",
      });
    } catch (error) {
      if (params.failOnStatusError || isAcpOwnerRepairRequired(error)) {
        throw error;
      }
      assertCurrent();
      logVerbose(
        `acp-manager: failed to refresh ACP runtime status for ${params.sessionKey}: ${String(error)}`,
      );
      return {
        handle: params.handle,
        meta: params.meta,
        runtimeStatus,
      };
    }
    const afterControl = params.revalidateControl?.();
    acpControl = afterControl ? (await afterControl) || undefined : acpControl;
    assertCurrent();
  }

  const now = Date.now();
  const currentIdentity = resolveSessionIdentityFromMeta(params.meta);
  const eventIdentity = createIdentityFromHandleEvent({
    handle: params.handle,
    now,
  });
  const identityAfterEvent =
    mergeSessionIdentity({
      current: currentIdentity,
      incoming: eventIdentity,
      now,
    }) ?? currentIdentity;
  const nextIdentity =
    mergeSessionIdentity({
      current: identityAfterEvent,
      incoming: createIdentityFromStatus({
        status: runtimeStatus,
        now,
      }),
      now,
    }) ?? identityAfterEvent;
  const handleIdentifiers = resolveRuntimeHandleIdentifiersFromIdentity(nextIdentity);
  const handleChanged =
    handleIdentifiers.backendSessionId !== params.handle.backendSessionId ||
    handleIdentifiers.agentSessionId !== params.handle.agentSessionId;
  const nextHandle: AcpRuntimeHandle = handleChanged
    ? {
        ...params.handle,
        ...(handleIdentifiers.backendSessionId
          ? { backendSessionId: handleIdentifiers.backendSessionId }
          : {}),
        ...(handleIdentifiers.agentSessionId
          ? { agentSessionId: handleIdentifiers.agentSessionId }
          : {}),
      }
    : params.handle;
  if (handleChanged) {
    params.setCachedHandle(params, nextHandle);
  }

  const metaChanged =
    !identityEquals(currentIdentity, nextIdentity) || hasLegacyAcpIdentityProjection(params.meta);
  if (!metaChanged) {
    assertCurrent();
    return {
      handle: nextHandle,
      meta: params.meta,
      runtimeStatus,
    };
  }
  const nextMeta: SessionAcpMeta = {
    backend: params.meta.backend,
    agent: params.meta.agent,
    runtimeSessionName: params.meta.runtimeSessionName,
    ...(nextIdentity ? { identity: nextIdentity } : {}),
    mode: params.meta.mode,
    ...(params.meta.runtimeOptions ? { runtimeOptions: params.meta.runtimeOptions } : {}),
    ...(params.meta.cwd ? { cwd: params.meta.cwd } : {}),
    lastActivityAt: now,
    state: params.meta.state,
    ...(params.meta.lastError ? { lastError: params.meta.lastError } : {}),
  };
  assertCurrent();
  if (!identityEquals(currentIdentity, nextIdentity)) {
    const currentAgentSessionId = currentIdentity?.agentSessionId ?? "<none>";
    const nextAgentSessionId = nextIdentity?.agentSessionId ?? "<none>";
    const currentAcpxSessionId = currentIdentity?.acpxSessionId ?? "<none>";
    const nextAcpxSessionId = nextIdentity?.acpxSessionId ?? "<none>";
    const currentAcpxRecordId = currentIdentity?.acpxRecordId ?? "<none>";
    const nextAcpxRecordId = nextIdentity?.acpxRecordId ?? "<none>";
    logVerbose(
      `acp-manager: session identity updated for ${params.sessionKey} ` +
        `(agentSessionId ${currentAgentSessionId} -> ${nextAgentSessionId}, ` +
        `acpxSessionId ${currentAcpxSessionId} -> ${nextAcpxSessionId}, ` +
        `acpxRecordId ${currentAcpxRecordId} -> ${nextAcpxRecordId})`,
    );
  }
  await params.writeSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    isCurrentActor,
    assertCommitAllowed: assertCurrent,
    acpControl,
    mutate: (current, entry) => {
      if (!isCurrentActor()) {
        return undefined;
      }
      params.assertCurrent?.();
      if (!entry) {
        return null;
      }
      const base = current;
      if (!base) {
        return null;
      }
      return {
        backend: base.backend,
        agent: base.agent,
        runtimeSessionName: base.runtimeSessionName,
        ...(nextIdentity ? { identity: nextIdentity } : {}),
        mode: base.mode,
        ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
        ...(base.cwd ? { cwd: base.cwd } : {}),
        state: base.state,
        lastActivityAt: now,
        ...(base.lastError ? { lastError: base.lastError } : {}),
      };
    },
  });
  assertCurrent();
  return {
    handle: nextHandle,
    meta: nextMeta,
    runtimeStatus,
  };
}
