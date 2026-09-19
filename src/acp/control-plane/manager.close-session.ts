/** Close/reset path for ACP runtime sessions and persisted manager metadata. */
import {
  identityHasStableSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import { logVerbose } from "../../globals.js";
import { toAcpRuntimeError } from "../runtime/errors.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { createSupersededActorError } from "./manager.runtime-handle-ensure.js";
import { isAcpOwnerRepairRequired } from "./manager.runtime-owner.js";
import {
  discardPersistedManagerRuntimeState,
  isRecoverableManagerAcpxExitError,
  tryPrepareFreshManagerRuntimeSession,
} from "./manager.runtime-resume-state.js";
import type {
  AcpCloseSessionInput,
  AcpCloseSessionResult,
  AcpSessionManagerDeps,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import { requireReadySessionMeta, resolveAcpSessionResolutionError } from "./manager.utils.js";

/** Closes an ACP session runtime handle and optionally discards persistent state/meta. */
export async function runManagerCloseSession(params: {
  input: AcpCloseSessionInput;
  sessionKey: string;
  agentId: string;
  deps: Pick<AcpSessionManagerDeps, "getRuntimeBackend">;
  runtimeHandles: ManagerRuntimeHandleCache;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
  isCurrentActor: () => boolean;
}): Promise<AcpCloseSessionResult> {
  const { input, sessionKey, agentId } = params;
  if (!params.isCurrentActor()) {
    throw createSupersededActorError(sessionKey);
  }
  const resolution = params.resolveSession({
    cfg: input.cfg,
    sessionKey,
    agentId,
  });
  const resolutionError = resolveAcpSessionResolutionError(resolution);
  if (resolutionError) {
    if (input.requireAcpSession ?? true) {
      throw resolutionError;
    }
    return {
      runtimeClosed: false,
      metaCleared: false,
    };
  }
  const meta = requireReadySessionMeta(resolution);
  const currentIdentity = resolveSessionIdentityFromMeta(meta);
  const shouldSkipRuntimeClose =
    input.discardPersistentState &&
    currentIdentity != null &&
    !identityHasStableSessionId(currentIdentity);

  let runtimeClosed = false;
  let runtimeNotice: string | undefined;
  if (shouldSkipRuntimeClose) {
    await tryPrepareFreshManagerRuntimeSession({
      deps: params.deps,
      cfg: input.cfg,
      meta,
      sessionKey,
      agentId,
      logPrefix: "acp close fast-reset",
    }).catch((freshError: unknown) => {
      if (!isAcpOwnerRepairRequired(freshError) || !input.clearMeta) {
        throw freshError;
      }
      logVerbose(
        `acp close fast-reset: fresh-session preparation blocked by owner-repair verdict for ${sessionKey}; proceeding with discard`,
      );
    });
    if (!params.isCurrentActor()) {
      throw createSupersededActorError(sessionKey);
    }
    params.runtimeHandles.clear(params);
  } else {
    try {
      const { runtime: ensuredRuntime, handle } = await params.ensureRuntimeHandle({
        cfg: input.cfg,
        sessionKey,
        agentId,
        meta,
        isCurrentActor: params.isCurrentActor,
      });
      if (!params.isCurrentActor()) {
        throw createSupersededActorError(sessionKey);
      }
      await ensuredRuntime.close({
        handle,
        reason: input.reason,
        discardPersistentState: input.discardPersistentState,
      });
      runtimeClosed = true;
      if (!params.isCurrentActor()) {
        throw createSupersededActorError(sessionKey);
      }
      params.runtimeHandles.clear(params);
    } catch (error) {
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP close failed before completion.",
      });
      if (!params.isCurrentActor()) {
        throw acpError;
      }
      const isOwnerRepair = isAcpOwnerRepairRequired(acpError);
      const isDiscardingWithClearMeta =
        Boolean(input.discardPersistentState) && Boolean(input.clearMeta);
      const allowOwnerRepairRecovery =
        isOwnerRepair && isDiscardingWithClearMeta && acpError.code === "ACP_SESSION_INIT_FAILED";
      if (
        input.allowBackendUnavailable &&
        ((!isOwnerRepair &&
          (acpError.code === "ACP_BACKEND_MISSING" ||
            acpError.code === "ACP_BACKEND_UNAVAILABLE" ||
            (input.discardPersistentState && acpError.code === "ACP_SESSION_INIT_FAILED") ||
            (input.discardPersistentState && acpError.code === "ACP_BACKEND_UNSUPPORTED_CONTROL") ||
            isRecoverableManagerAcpxExitError(acpError.message))) ||
          allowOwnerRepairRecovery)
      ) {
        if (input.discardPersistentState) {
          await tryPrepareFreshManagerRuntimeSession({
            deps: params.deps,
            cfg: input.cfg,
            meta,
            sessionKey,
            agentId,
            logPrefix: "acp close recovery",
            missingBackendError: acpError,
          }).catch((freshError: unknown) => {
            if (!isAcpOwnerRepairRequired(freshError) || !input.clearMeta) {
              throw freshError;
            }
            logVerbose(
              `acp close recovery: fresh-session preparation blocked by owner-repair verdict for ${sessionKey}; proceeding with discard`,
            );
          });
          if (!params.isCurrentActor()) {
            throw acpError;
          }
        }
        // Treat unavailable backends as terminal for this cached handle so a
        // later operation cannot reuse an unusable runtime.
        if (!params.isCurrentActor()) {
          throw createSupersededActorError(sessionKey);
        }
        params.runtimeHandles.clear(params);
        runtimeNotice = acpError.message;
      } else {
        throw acpError;
      }
    }
  }

  if (input.discardPersistentState && !input.clearMeta) {
    await discardPersistedManagerRuntimeState({
      cfg: input.cfg,
      sessionKey,
      agentId,
      writeSessionMeta: params.writeSessionMeta,
      isCurrentActor: params.isCurrentActor,
    });
  }

  if (!params.isCurrentActor()) {
    throw createSupersededActorError(sessionKey);
  }
  const metaCleared = Boolean(input.clearMeta);
  if (metaCleared) {
    await params.writeSessionMeta({
      cfg: input.cfg,
      sessionKey,
      agentId,
      isCurrentActor: params.isCurrentActor,
      mutate: () => null,
      failOnError: true,
    });
  }

  return {
    runtimeClosed,
    runtimeNotice,
    metaCleared,
  };
}
