/** Close/reset path for ACP runtime sessions and persisted manager metadata. */
import {
  identityHasStableSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { SessionEntry } from "../../config/sessions/types.js";
import { toAcpRuntimeError } from "../runtime/errors.js";
import { matchesAcpSessionControlBinding } from "../runtime/session-control-owner.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import {
  createSupersededActorError,
  isSupersededActorError,
} from "./manager.runtime-handle-ensure.js";
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
  ResolveManagerSessionAsync,
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
  resolveSession: ResolveManagerSessionAsync;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
  isCurrentActor: () => boolean;
}): Promise<AcpCloseSessionResult> {
  const { input, sessionKey, agentId } = params;
  const expectedControlBinding = input.expectedControlBinding;
  const assertCurrent = () => {
    if (!params.isCurrentActor()) {
      throw createSupersededActorError(sessionKey);
    }
    input.assertActive?.();
  };
  assertCurrent();
  const resolution = await params.resolveSession({
    cfg: input.cfg,
    sessionKey,
    agentId,
    assertCurrent,
  });
  assertCurrent();
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
  const assertControlBinding = (entry: SessionEntry | undefined) => {
    if (expectedControlBinding && !matchesAcpSessionControlBinding(entry, expectedControlBinding)) {
      throw createSupersededActorError(sessionKey);
    }
  };
  const refreshControlBinding = async () => {
    const current = await params.resolveSession({
      cfg: input.cfg,
      sessionKey,
      agentId,
      assertCurrent,
    });
    assertCurrent();
    assertControlBinding(current.kind === "ready" ? current.entry : undefined);
  };
  assertControlBinding(resolution.kind === "ready" ? resolution.entry : undefined);
  const meta = requireReadySessionMeta(resolution);
  const currentIdentity = resolveSessionIdentityFromMeta(meta);
  const shouldSkipRuntimeClose =
    input.discardPersistentState &&
    currentIdentity != null &&
    !identityHasStableSessionId(currentIdentity);

  let runtimeClosed = false;
  let runtimeNotice: string | undefined;
  if (shouldSkipRuntimeClose) {
    input.assertActive?.();
    await tryPrepareFreshManagerRuntimeSession({
      deps: params.deps,
      cfg: input.cfg,
      meta,
      sessionKey,
      agentId,
      logPrefix: "acp close fast-reset",
    });
    assertCurrent();
    params.runtimeHandles.clear(params);
  } else {
    try {
      const { runtime: ensuredRuntime, handle } = await params.ensureRuntimeHandle({
        assertActive: assertCurrent,
        expectedControlBinding,
        cfg: input.cfg,
        sessionKey,
        agentId,
        meta,
        isCurrentActor: params.isCurrentActor,
      });
      if (!params.isCurrentActor()) {
        throw createSupersededActorError(sessionKey);
      }
      input.assertActive?.();
      if (expectedControlBinding) {
        await refreshControlBinding();
      }
      assertCurrent();
      await ensuredRuntime.close({
        handle,
        reason: input.reason,
        discardPersistentState: input.discardPersistentState,
      });
      runtimeClosed = true;
      assertCurrent();
      params.runtimeHandles.clear(params);
    } catch (error) {
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP close failed before completion.",
      });
      if (!params.isCurrentActor() || isSupersededActorError(acpError)) {
        throw acpError;
      }
      input.assertActive?.();
      if (
        !isAcpOwnerRepairRequired(acpError) &&
        input.allowBackendUnavailable &&
        (acpError.code === "ACP_BACKEND_MISSING" ||
          acpError.code === "ACP_BACKEND_UNAVAILABLE" ||
          (input.discardPersistentState && acpError.code === "ACP_SESSION_INIT_FAILED") ||
          (input.discardPersistentState && acpError.code === "ACP_BACKEND_UNSUPPORTED_CONTROL") ||
          isRecoverableManagerAcpxExitError(acpError.message))
      ) {
        if (expectedControlBinding) {
          await refreshControlBinding();
        }
        assertCurrent();
        if (input.discardPersistentState) {
          input.assertActive?.();
          await tryPrepareFreshManagerRuntimeSession({
            deps: params.deps,
            cfg: input.cfg,
            meta,
            sessionKey,
            agentId,
            logPrefix: "acp close recovery",
            missingBackendError: acpError,
          });
          assertCurrent();
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

  assertCurrent();
  if (input.discardPersistentState && !input.clearMeta) {
    await discardPersistedManagerRuntimeState({
      assertCommitAllowed: assertCurrent,
      expectedControlBinding,
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
  assertCurrent();
  const metaCleared = Boolean(input.clearMeta);
  if (metaCleared) {
    await params.writeSessionMeta({
      assertCommitAllowed: assertCurrent,
      expectedControlBinding,
      cfg: input.cfg,
      sessionKey,
      agentId,
      isCurrentActor: params.isCurrentActor,
      mutate: () => null,
      failOnError: true,
    });
    assertCurrent();
  }

  return {
    runtimeClosed,
    runtimeNotice,
    metaCleared,
  };
}
