/** Ensures or recreates a live ACP runtime handle for persisted session metadata. */
import {
  createIdentityFromEnsure,
  identityEquals,
  identityHasStableSessionId,
  mergeSessionIdentity,
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveRuntimeResumeSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import {
  AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import {
  matchesAcpSessionControlBinding,
  resolveAcpSessionControlOwner,
  type AcpSessionControlBinding,
  type AcpSessionRuntimeLocator,
} from "../runtime/session-control-owner.js";
import type { AcpSessionControlConstraint } from "../runtime/session-meta-control.types.js";
import { assertAcpSessionMutationEntry } from "../runtime/session-meta-entry.kernel.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import {
  assertAcpRuntimeOwnerSupport,
  isAcpOwnerRepairRequired,
  persistedAcpRuntimeHandle,
} from "./manager.runtime-owner.js";
import type {
  AcpSessionManagerDeps,
  SessionAcpMeta,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import {
  assertCurrentAcpActor,
  createSupersededActorError,
  isSupersededActorError,
  hasLegacyAcpIdentityProjection,
  resolveAcpAgentFromSessionKey,
} from "./manager.utils.js";
import {
  normalizeRuntimeOptions,
  normalizeText,
  resolveRuntimeOptionsFromMeta,
  runtimeOptionsEqual,
} from "./runtime-options.js";

/** Returns a reusable cached handle or initializes a fresh runtime session for the metadata. */
export async function ensureManagerRuntimeHandle(params: {
  assertMetadataCommitAllowed?: (expectedLocator: AcpSessionRuntimeLocator) => void;
  readAcpControl?: () => AcpSessionControlConstraint | undefined;
  assertActive?: () => void;
  expectedControlBinding?: AcpSessionControlBinding;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  meta: SessionAcpMeta;
  selectedBackend?: string;
  deps: Pick<AcpSessionManagerDeps, "requireRuntimeBackend" | "loadSessionEntryAsync">;
  runtimeHandles: ManagerRuntimeHandleCache;
  writeSessionMeta: WriteManagerSessionMeta;
  isCurrentActor?: () => boolean;
}): Promise<{ runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpMeta }> {
  const setupLocator: AcpSessionRuntimeLocator = {
    backend: params.meta.backend,
    runtimeSessionName: params.meta.runtimeSessionName,
  };
  const isCurrentActor = params.isCurrentActor ?? (() => true);
  const expectedControlBinding = params.expectedControlBinding
    ? { ...params.expectedControlBinding }
    : undefined;
  const assertCurrent = () => {
    assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
    params.assertActive?.();
  };
  const assertControlBindingCurrent = async () => {
    assertCurrent();
    const current = await params.deps.loadSessionEntryAsync({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      clone: false,
      assertCurrent,
    });
    assertCurrent();
    const control = params.readAcpControl?.();
    if (control) {
      assertAcpSessionMutationEntry(
        current?.entry,
        control.entry ?? null,
        undefined,
        "control read",
      );
      if (!current?.acp || resolveAcpSessionControlOwner(current.entry) !== control.ownerKey) {
        throw createSupersededActorError(params.sessionKey);
      }
    }
    if (
      current?.storeReadFailed ||
      (expectedControlBinding &&
        !matchesAcpSessionControlBinding(current?.entry, expectedControlBinding))
    ) {
      throw createSupersededActorError(params.sessionKey);
    }
  };
  assertCurrent();
  const agent =
    normalizeText(params.meta.agent) || resolveAcpAgentFromSessionKey(params.sessionKey, "main");
  const mode = params.meta.mode;
  const runtimeOptions = resolveRuntimeOptionsFromMeta(params.meta);
  const cwd = runtimeOptions.cwd ?? normalizeText(params.meta.cwd);
  const model = normalizeText(runtimeOptions.model);
  const thinking = normalizeText(runtimeOptions.thinking);
  const configuredBackend = (
    params.selectedBackend ||
    params.meta.backend ||
    params.cfg.acp?.backend ||
    ""
  ).trim();
  const backend = params.deps.requireRuntimeBackend(configuredBackend || undefined);
  const runtime = backend.runtime;
  assertAcpRuntimeOwnerSupport(runtime, params);
  const cached = params.runtimeHandles.get(params);
  if (cached) {
    const backendMatches = !configuredBackend || cached.backend === configuredBackend;
    const agentMatches = cached.agent === agent;
    const modeMatches = cached.mode === mode;
    const cwdMatches = (cached.cwd ?? "") === (cwd ?? "");
    const handleMatchesMeta = params.runtimeHandles.handleMatchesMeta({
      handle: cached.handle,
      meta: params.meta,
    });
    const reusable =
      backendMatches &&
      agentMatches &&
      modeMatches &&
      cwdMatches &&
      cached.runtime === runtime &&
      handleMatchesMeta &&
      (await params.runtimeHandles.isReusable({
        sessionKey: params.sessionKey,
        runtime: cached.runtime,
        handle: cached.handle,
      }));
    assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
    params.assertActive?.();
    if (expectedControlBinding || params.readAcpControl?.()) {
      await assertControlBindingCurrent();
    }
    if (reusable) {
      assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
      return {
        runtime: cached.runtime,
        handle: cached.handle,
        meta: params.meta,
      };
    }
    await params.runtimeHandles.close({
      assertActive: params.assertActive,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      reason: "runtime-handle-replaced",
      expectedHandle: cached.handle,
    });
    assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
  }

  const previousMeta = params.meta;
  const persistedIdentity = resolveSessionIdentityFromMeta(previousMeta);
  // Identifiers belong to their persisted backend; a new backend may recover its own named session.
  const backendOwnsPreviousIdentity = previousMeta.backend === backend.id;
  const previousIdentity = backendOwnsPreviousIdentity ? persistedIdentity : undefined;
  const persistedHandle = backendOwnsPreviousIdentity
    ? persistedAcpRuntimeHandle(params, previousMeta)
    : undefined;
  let identityForEnsure = previousIdentity;
  const persistedResumeSessionId =
    mode === "persistent" ? resolveRuntimeResumeSessionId(previousIdentity) : undefined;
  const shouldPrepareFreshPersistentSession =
    mode === "persistent" &&
    previousIdentity != null &&
    !identityHasStableSessionId(previousIdentity);
  const ensureSession = async (resumeSessionId?: string) => {
    if (expectedControlBinding || params.readAcpControl?.()) {
      await assertControlBindingCurrent();
    }
    assertCurrent();
    const ensured = await withAcpRuntimeErrorBoundary({
      run: async () =>
        await runtime.ensureSession({
          persistedHandle,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          agent,
          mode,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          // Stored options lack caller intent; runtime controls validate the
          // saved model before submitting any prompt.
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          cwd,
        }),
      fallbackCode: "ACP_SESSION_INIT_FAILED",
      fallbackMessage: "Could not initialize ACP session runtime.",
    });
    try {
      assertCurrent();
      if (params.readAcpControl?.()) {
        await assertControlBindingCurrent();
      }
      return ensured;
    } catch (error) {
      // A control read can yield to reset before the caller receives this handle.
      if (!isCurrentActor()) {
        await closeSupersededRuntimeHandle({
          runtime,
          handle: ensured,
          sessionKey: params.sessionKey,
        });
      }
      throw error;
    }
  };
  let ensured: AcpRuntimeHandle;
  if (shouldPrepareFreshPersistentSession) {
    assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
    if (expectedControlBinding || params.readAcpControl?.()) {
      await assertControlBindingCurrent();
    }
    assertCurrent();
    await runtime.prepareFreshSession?.({
      persistedHandle,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
  }
  if (persistedResumeSessionId) {
    try {
      ensured = await ensureSession(persistedResumeSessionId);
    } catch (error) {
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      });
      if (!isCurrentActor()) {
        throw acpError;
      }
      params.assertActive?.();
      if (
        isAcpOwnerRepairRequired(acpError) ||
        isSupersededActorError(acpError) ||
        acpError.code !== "ACP_SESSION_INIT_FAILED"
      ) {
        throw acpError;
      }
      logVerbose(
        `acp-manager: resume init failed for ${params.sessionKey}; retrying without persisted ACP session id: ${acpError.message}`,
      );
      if (identityForEnsure) {
        const {
          acpxSessionId: _staleAcpxSessionId,
          agentSessionId: _staleAgentSessionId,
          ...retryIdentity
        } = identityForEnsure;
        // The persisted resume identifiers already failed, so do not merge them back into the
        // fresh named-session handle returned by the retry path.
        identityForEnsure = {
          ...retryIdentity,
          state: "pending",
        };
      }
      ensured = await ensureSession();
    }
  } else {
    ensured = await ensureSession();
  }

  const now = Date.now();
  const effectiveCwd = normalizeText(ensured.cwd) ?? cwd;
  const nextRuntimeOptions = normalizeRuntimeOptions({
    ...runtimeOptions,
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
  });
  const ensuredIdentity = createIdentityFromEnsure({ handle: ensured, now });
  // A new physical record cannot inherit resolved IDs from the previous record.
  // In particular, a completed oneshot may be re-ensured for cleanup or status.
  if (
    identityForEnsure?.acpxRecordId &&
    ensuredIdentity?.acpxRecordId &&
    identityForEnsure.acpxRecordId !== ensuredIdentity.acpxRecordId
  ) {
    identityForEnsure = undefined;
  }
  const nextIdentity =
    mergeSessionIdentity({
      current: identityForEnsure,
      incoming: ensuredIdentity,
      now,
    }) ?? identityForEnsure;
  const nextHandleIdentifiers = resolveRuntimeHandleIdentifiersFromIdentity(nextIdentity);
  const normalizedBackend = ensured.backend || backend.id;
  const nextHandle: AcpRuntimeHandle = {
    ...ensured,
    backend: normalizedBackend,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    ...(nextHandleIdentifiers.backendSessionId
      ? { backendSessionId: nextHandleIdentifiers.backendSessionId }
      : {}),
    ...(nextHandleIdentifiers.agentSessionId
      ? { agentSessionId: nextHandleIdentifiers.agentSessionId }
      : {}),
  };
  const nextMeta: SessionAcpMeta = {
    backend: normalizedBackend,
    agent,
    runtimeSessionName: ensured.runtimeSessionName,
    ...(nextIdentity ? { identity: nextIdentity } : {}),
    mode: params.meta.mode,
    ...(Object.keys(nextRuntimeOptions).length > 0 ? { runtimeOptions: nextRuntimeOptions } : {}),
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    state: previousMeta.state,
    lastActivityAt: now,
    ...(previousMeta.lastError ? { lastError: previousMeta.lastError } : {}),
  };
  const shouldPersistMeta =
    previousMeta.backend !== nextMeta.backend ||
    previousMeta.runtimeSessionName !== nextMeta.runtimeSessionName ||
    !identityEquals(persistedIdentity, nextIdentity) ||
    previousMeta.agent !== nextMeta.agent ||
    previousMeta.cwd !== nextMeta.cwd ||
    !runtimeOptionsEqual(previousMeta.runtimeOptions, nextMeta.runtimeOptions) ||
    hasLegacyAcpIdentityProjection(previousMeta);
  try {
    assertCurrent();
    if (shouldPersistMeta) {
      const control = params.readAcpControl?.();
      const writeLocator = control?.runtimeLocator ?? setupLocator;
      const acpControl = control ? { ...control, runtimeLocator: writeLocator } : undefined;
      const publication: { refusal?: { error: unknown } } = {};
      const assertPublicationCurrent = () => {
        try {
          assertCurrent();
          params.assertMetadataCommitAllowed?.(writeLocator);
          if (!control && params.readAcpControl?.()) {
            throw new AcpRuntimeError(
              "ACP_TURN_FAILED",
              "ACP cancellation was admitted after metadata preparation.",
            );
          }
        } catch (error) {
          publication.refusal ??= { error };
          throw error;
        }
      };
      assertPublicationCurrent();
      await params.writeSessionMeta({
        assertCommitAllowed: assertPublicationCurrent,
        ...(expectedControlBinding ? { expectedControlBinding, failOnError: true } : {}),
        ...(acpControl ? { acpControl, failOnError: true } : {}),
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        isCurrentActor,
        mutate: (_current, entry) => {
          assertCurrent();
          return entry ? nextMeta : null;
        },
      });
      // Ordinary writes may log errors; a refused cancellation publication cannot be cached.
      if (publication.refusal) {
        throw publication.refusal.error;
      }
    }
    if (expectedControlBinding || params.readAcpControl?.()) {
      await assertControlBindingCurrent();
    }
    assertCurrent();
    params.runtimeHandles.set(params, {
      runtime,
      handle: nextHandle,
      backend: normalizedBackend,
      agent,
      mode,
      cwd: effectiveCwd,
      appliedControlSignature: undefined,
    });
    return {
      runtime,
      handle: nextHandle,
      meta: nextMeta,
    };
  } catch (error) {
    // Ensure can reopen backend-owned state; task/binding loss grants no right to discard it.
    if (!isCurrentActor()) {
      await closeSupersededRuntimeHandle({
        runtime,
        handle: nextHandle,
        sessionKey: params.sessionKey,
      });
    }
    throw error;
  }
}

export async function closeSupersededRuntimeHandle(params: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  sessionKey: string;
}): Promise<void> {
  await params.runtime
    .close({
      handle: params.handle,
      reason: "session-actor-superseded",
      discardPersistentState: true,
    })
    .catch((error: unknown) => {
      logVerbose(
        `acp-manager: failed discarding superseded runtime for ${params.sessionKey}: ${String(error)}`,
      );
    });
}
