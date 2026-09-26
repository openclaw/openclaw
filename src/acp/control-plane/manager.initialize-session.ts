/** Session initialization path for ACP runtime handles and persisted manager metadata. */
import {
  createIdentityFromEnsure,
  mergeSessionIdentity,
} from "@openclaw/acp-core/runtime/session-identity";
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { logVerbose } from "../../globals.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import {
  closeSupersededRuntimeHandle,
  createSupersededActorError,
} from "./manager.runtime-handle-ensure.js";
import {
  assertAcpRuntimeOwnerSupport,
  persistedAcpRuntimeHandle,
} from "./manager.runtime-owner.js";
import type {
  AcpInitializeSessionInput,
  AcpSessionManagerDeps,
  SessionAcpMeta,
  SessionEntry,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import {
  normalizeRuntimeOptions,
  normalizeText,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";

/** Initializes an ACP runtime session and persists its metadata before caching the handle. */
export async function runManagerInitializeSession(params: {
  input: AcpInitializeSessionInput;
  sessionKey: string;
  agentId: string;
  deps: Pick<AcpSessionManagerDeps, "requireRuntimeBackend" | "loadSessionEntryAsync">;
  runtimeHandles: ManagerRuntimeHandleCache;
  writeSessionMeta: WriteManagerSessionMeta;
  isCurrentActor?: () => boolean;
}): Promise<{
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  sessionEntry: SessionEntry;
}> {
  const { input, sessionKey, agentId } = params;
  const isCurrentActor = params.isCurrentActor ?? (() => true);
  if (!isCurrentActor()) {
    throw createSupersededActorError(sessionKey);
  }
  const backend = params.deps.requireRuntimeBackend(input.backendId || input.cfg.acp?.backend);
  const runtime = backend.runtime;
  assertAcpRuntimeOwnerSupport(runtime, params);
  const agent = normalizeAgentId(input.agent);
  const initialRuntimeOptions = validateRuntimeOptionPatch({
    ...input.runtimeOptions,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  });
  const requestedCwd = initialRuntimeOptions.cwd;
  const requestedModel = initialRuntimeOptions.model;
  const requestedThinking = initialRuntimeOptions.thinking;
  const assertCurrent = () => {
    if (!isCurrentActor()) {
      throw createSupersededActorError(sessionKey);
    }
    input.assertActive?.();
  };
  const previousMeta = (
    await params.deps.loadSessionEntryAsync({
      cfg: input.cfg,
      sessionKey,
      agentId,
      assertCurrent,
    })
  )?.acp;
  assertCurrent();
  input.assertActive?.();
  const ensured = await withAcpRuntimeErrorBoundary({
    run: async () =>
      await runtime.ensureSession({
        sessionKey,
        agentId,
        persistedHandle:
          previousMeta?.backend === backend.id
            ? persistedAcpRuntimeHandle(params, previousMeta)
            : undefined,
        agent,
        mode: input.mode,
        resumeSessionId: input.resumeSessionId,
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(requestedModel && input.modelExplicit ? { modelExplicit: true } : {}),
        ...(requestedThinking ? { thinking: requestedThinking } : {}),
        ...(requestedThinking && input.thinkingExplicit !== undefined
          ? { thinkingExplicit: input.thinkingExplicit }
          : {}),
        cwd: requestedCwd,
      }),
    fallbackCode: "ACP_SESSION_INIT_FAILED",
    fallbackMessage: "Could not initialize ACP session runtime.",
  });
  const handle = { ...ensured, agentId, sessionKey };
  if (!isCurrentActor()) {
    await closeSupersededRuntimeHandle({ runtime, handle, sessionKey });
    throw createSupersededActorError(sessionKey);
  }
  const effectiveCwd = normalizeText(handle.cwd) ?? requestedCwd;
  const effectiveRuntimeOptions = normalizeRuntimeOptions({
    ...initialRuntimeOptions,
    model: handle.appliedModel
      ? handle.appliedModel.kind === "applied"
        ? handle.appliedModel.model
        : undefined
      : requestedModel,
    thinking: handle.appliedThinking
      ? handle.appliedThinking.kind === "applied"
        ? handle.appliedThinking.thinking
        : undefined
      : requestedThinking,
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
  });

  const identityNow = Date.now();
  const initializedIdentity =
    mergeSessionIdentity({
      current: undefined,
      incoming: createIdentityFromEnsure({
        handle,
        now: identityNow,
      }),
      now: identityNow,
    }) ??
    ({
      state: "pending",
      source: "ensure",
      lastUpdatedAt: identityNow,
    } as const);
  const meta: SessionAcpMeta = {
    backend: handle.backend || backend.id,
    agent,
    runtimeSessionName: handle.runtimeSessionName,
    identity: initializedIdentity,
    mode: input.mode,
    ...(Object.keys(effectiveRuntimeOptions).length > 0
      ? { runtimeOptions: effectiveRuntimeOptions }
      : {}),
    cwd: effectiveCwd,
    state: "idle",
    lastActivityAt: Date.now(),
  };

  let persisted: SessionEntry | null;
  try {
    persisted = await params.writeSessionMeta({
      cfg: input.cfg,
      sessionKey,
      agentId,
      mutate: () => meta,
      isCurrentActor,
      failOnError: true,
      assertCommitAllowed: input.assertActive,
    });
    if (!persisted?.acp) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `Could not persist ACP metadata for ${sessionKey}.`,
      );
    }
  } catch (error) {
    await runtime.close({ handle, reason: "init-meta-failed" }).catch((closeError: unknown) => {
      logVerbose(
        `acp-manager: cleanup close failed after metadata write error for ${sessionKey}: ${String(closeError)}`,
      );
    });
    throw error;
  }
  if (!isCurrentActor()) {
    await closeSupersededRuntimeHandle({ runtime, handle, sessionKey });
    throw createSupersededActorError(sessionKey);
  }
  params.runtimeHandles.set(params, {
    runtime,
    handle,
    backend: handle.backend || backend.id,
    agent,
    mode: input.mode,
    cwd: effectiveCwd,
  });
  return {
    runtime,
    handle,
    meta,
    sessionEntry: persisted,
  };
}
