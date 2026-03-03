import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import {
  AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import {
  createIdentityFromEnsure,
  identityEquals,
  isSessionIdentityPending,
  mergeSessionIdentity,
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveSessionIdentityFromMeta,
} from "../runtime/session-identity.js";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "../runtime/types.js";
import { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile.js";
import {
  applyManagerRuntimeControls,
  resolveManagerRuntimeCapabilities,
} from "./manager.runtime-controls.js";
import {
  type AcpCloseSessionInput,
  type AcpCloseSessionResult,
  type AcpInitializeSessionInput,
  type AcpManagerObservabilitySnapshot,
  type AcpRunTurnInput,
  type AcpSessionManagerDeps,
  type AcpSessionResolution,
  type AcpSessionRuntimeOptions,
  type AcpSessionStatus,
  type AcpStartupIdentityReconcileResult,
  type ActiveTurnState,
  DEFAULT_DEPS,
  type SessionAcpMeta,
  type SessionEntry,
  type TurnLatencyStats,
} from "./manager.types.js";
import {
  createUnsupportedControlError,
  hasLegacyAcpIdentityProjection,
  normalizeAcpErrorCode,
  normalizeActorKey,
  normalizeSessionKey,
  resolveAcpAgentFromSessionKey,
  resolveMissingMetaError,
  resolveRuntimeIdleTtlMs,
} from "./manager.utils.js";
import { CachedRuntimeState, RuntimeCache } from "./runtime-cache.js";
import {
  inferRuntimeOptionPatchFromConfigOption,
  mergeRuntimeOptions,
  normalizeRuntimeOptions,
  normalizeText,
  resolveRuntimeOptionsFromMeta,
  runtimeOptionsEqual,
  validateRuntimeConfigOptionInput,
  validateRuntimeModeInput,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";
import { SessionActorQueue } from "./session-actor-queue.js";

export class AcpSessionManager {
  private readonly actorQueue = new SessionActorQueue();
  private readonly actorTailBySession = this.actorQueue.getTailMapForTesting();
  private readonly runtimeCache = new RuntimeCache();
  private readonly activeTurnBySession = new Map<string, ActiveTurnState>();
  private readonly turnLatencyStats: TurnLatencyStats = {
    completed: 0,
    failed: 0,
    totalMs: 0,
    maxMs: 0,
  };
  private readonly errorCountsByCode = new Map<string, number>();
  private evictedRuntimeCount = 0;
  private lastEvictedAt: number | undefined;

  constructor(private readonly deps: AcpSessionManagerDeps = DEFAULT_DEPS) {}

  resolveSession(params: { cfg: OpenClawConfig; sessionKey: string }): AcpSessionResolution {
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (!sessionKey) {
      return {
        kind: "none",
        sessionKey,
      };
    }
    const acp = this.deps.readSessionEntry({
      cfg: params.cfg,
      sessionKey,
    })?.acp;
    if (acp) {
      return {
        kind: "ready",
        sessionKey,
        meta: acp,
      };
    }
    if (isAcpSessionKey(sessionKey)) {
      return {
        kind: "stale",
        sessionKey,
        error: resolveMissingMetaError(sessionKey),
      };
    }
    return {
      kind: "none",
      sessionKey,
    };
  }

  getObservabilitySnapshot(cfg: OpenClawConfig): AcpManagerObservabilitySnapshot {
    const completedTurns = this.turnLatencyStats.completed + this.turnLatencyStats.failed;
    const averageLatencyMs =
      completedTurns > 0 ? Math.round(this.turnLatencyStats.totalMs / completedTurns) : 0;
    return {
      runtimeCache: {
        activeSessions: this.runtimeCache.size(),
        idleTtlMs: resolveRuntimeIdleTtlMs(cfg),
        evictedTotal: this.evictedRuntimeCount,
        ...(this.lastEvictedAt ? { lastEvictedAt: this.lastEvictedAt } : {}),
      },
      turns: {
        active: this.activeTurnBySession.size,
        queueDepth: this.actorQueue.getTotalPendingCount(),
        completed: this.turnLatencyStats.completed,
        failed: this.turnLatencyStats.failed,
        averageLatencyMs,
        maxLatencyMs: this.turnLatencyStats.maxMs,
      },
      errorsByCode: Object.fromEntries(
        [...this.errorCountsByCode.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }

  async reconcilePendingSessionIdentities(params: {
    cfg: OpenClawConfig;
  }): Promise<AcpStartupIdentityReconcileResult> {
    let checked = 0;
    let resolved = 0;
    let failed = 0;

    let acpSessions: Awaited<ReturnType<AcpSessionManagerDeps["listAcpSessions"]>>;
    try {
      acpSessions = await this.deps.listAcpSessions({
        cfg: params.cfg,
      });
    } catch (error) {
      logVerbose(`acp-manager: startup identity scan failed: ${String(error)}`);
      return { checked, resolved, failed: failed + 1 };
    }

    for (const session of acpSessions) {
      if (!session.acp || !session.sessionKey) {
        continue;
      }
      const currentIdentity = resolveSessionIdentityFromMeta(session.acp);
      if (!isSessionIdentityPending(currentIdentity)) {
        continue;
      }

      checked += 1;
      try {
        const becameResolved = await this.withSessionActor(session.sessionKey, async () => {
          const resolution = this.resolveSession({
            cfg: params.cfg,
            sessionKey: session.sessionKey,
          });
          if (resolution.kind !== "ready") {
            return false;
          }
          const { runtime, handle, meta } = await this.ensureRuntimeHandle({
            cfg: params.cfg,
            sessionKey: session.sessionKey,
            meta: resolution.meta,
          });
          const reconciled = await this.reconcileRuntimeSessionIdentifiers({
            cfg: params.cfg,
            sessionKey: session.sessionKey,
            runtime,
            handle,
            meta,
            failOnStatusError: false,
          });
          return !isSessionIdentityPending(resolveSessionIdentityFromMeta(reconciled.meta));
        });
        if (becameResolved) {
          resolved += 1;
        }
      } catch (error) {
        failed += 1;
        logVerbose(
          `acp-manager: startup identity reconcile failed for ${session.sessionKey}: ${String(error)}`,
        );
      }
    }

    return { checked, resolved, failed };
  }

  async initializeSession(input: AcpInitializeSessionInput): Promise<{
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
  }> {
    const sessionKey = normalizeSessionKey(input.sessionKey);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const agent = normalizeAgentId(input.agent);
    await this.evictIdleRuntimeHandles({ cfg: input.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const backend = this.deps.requireRuntimeBackend(input.backendId || input.cfg.acp?.backend);
      const runtime = backend.runtime;
      const initialRuntimeOptions = validateRuntimeOptionPatch({ cwd: input.cwd });
      const requestedCwd = initialRuntimeOptions.cwd;
      this.enforceConcurrentSessionLimit({
        cfg: input.cfg,
        sessionKey,
      });
      const handle = await withAcpRuntimeErrorBoundary({
        run: async () =>
          await runtime.ensureSession({
            sessionKey,
            agent,
            mode: input.mode,
            cwd: requestedCwd,
          }),
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      });
      const effectiveCwd = normalizeText(handle.cwd) ?? requestedCwd;
      const effectiveRuntimeOptions = normalizeRuntimeOptions({
        ...initialRuntimeOptions,
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
      try {
        const persisted = await this.writeSessionMeta({
          cfg: input.cfg,
          sessionKey,
          mutate: () => meta,
          failOnError: true,
        });
        if (!persisted?.acp) {
          throw new AcpRuntimeError(
            "ACP_SESSION_INIT_FAILED",
            `Could not persist ACP metadata for ${sessionKey}.`,
          );
        }
      } catch (error) {
        await runtime
          .close({
            handle,
            reason: "init-meta-failed",
          })
          .catch((closeError) => {
            logVerbose(
              `acp-manager: cleanup close failed after metadata write error for ${sessionKey}: ${String(closeError)}`,
            );
          });
        throw error;
      }
      this.setCachedRuntimeState(sessionKey, {
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
      };
    });
  }

  async getSessionStatus(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }): Promise<AcpSessionStatus> {
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      if (resolution.kind === "none") {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${sessionKey}`,
        );
      }
      if (resolution.kind === "stale") {
        throw resolution.error;
      }
      const {
        runtime,
        handle: ensuredHandle,
        meta: ensuredMeta,
      } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolution.meta,
      });
      let handle = ensuredHandle;
      let meta = ensuredMeta;
      const capabilities = await this.resolveRuntimeCapabilities({ runtime, handle });
      let runtimeStatus: AcpRuntimeStatus | undefined;
      if (runtime.getStatus) {
        runtimeStatus = await withAcpRuntimeErrorBoundary({
          run: async () => await runtime.getStatus!({ handle }),
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "Could not read ACP runtime status.",
        });
      }
      ({ handle, meta, runtimeStatus } = await this.reconcileRuntimeSessionIdentifiers({
        cfg: params.cfg,
        sessionKey,
        runtime,
        handle,
        meta,
        runtimeStatus,
        failOnStatusError: true,
      }));
      const identity = resolveSessionIdentityFromMeta(meta);
      return {
        sessionKey,
        backend: handle.backend || meta.backend,
        agent: meta.agent,
        ...(identity ? { identity } : {}),
        state: meta.state,
        mode: meta.mode,
        runtimeOptions: resolveRuntimeOptionsFromMeta(meta),
        capabilities,
        runtimeStatus,
        lastActivityAt: meta.lastActivityAt,
        lastError: meta.lastError,
      };
    });
  }

  async setSessionRuntimeMode(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    runtimeMode: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const runtimeMode = validateRuntimeModeInput(params.runtimeMode);

    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      if (resolution.kind === "none") {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${sessionKey}`,
        );
      }
      if (resolution.kind === "stale") {
        throw resolution.error;
      }
      const { runtime, handle, meta } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolution.meta,
      });
      const capabilities = await this.resolveRuntimeCapabilities({ runtime, handle });
      if (!capabilities.controls.includes("session/set_mode") || !runtime.setMode) {
        throw createUnsupportedControlError({
          backend: handle.backend || meta.backend,
          control: "session/set_mode",
        });
      }

      await withAcpRuntimeErrorBoundary({
        run: async () =>
          await runtime.setMode!({
            handle,
            mode: runtimeMode,
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP runtime mode.",
      });

      const nextOptions = mergeRuntimeOptions({
        current: resolveRuntimeOptionsFromMeta(meta),
        patch: { runtimeMode },
      });
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        options: nextOptions,
      });
      return nextOptions;
    });
  }

  async setSessionConfigOption(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    key: string;
    value: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const normalizedOption = validateRuntimeConfigOptionInput(params.key, params.value);
    const key = normalizedOption.key;
    const value = normalizedOption.value;

    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      if (resolution.kind === "none") {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${sessionKey}`,
        );
      }
      if (resolution.kind === "stale") {
        throw resolution.error;
      }
      const { runtime, handle, meta } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolution.meta,
      });
      const inferredPatch = inferRuntimeOptionPatchFromConfigOption(key, value);
      const capabilities = await this.resolveRuntimeCapabilities({ runtime, handle });
      if (
        !capabilities.controls.includes("session/set_config_option") ||
        !runtime.setConfigOption
      ) {
        throw createUnsupportedControlError({
          backend: handle.backend || meta.backend,
          control: "session/set_config_option",
        });
      }

      const advertisedKeys = new Set(
        (capabilities.configOptionKeys ?? [])
          .map((entry) => normalizeText(entry))
          .filter(Boolean) as string[],
      );
      if (advertisedKeys.size > 0 && !advertisedKeys.has(key)) {
        throw new AcpRuntimeError(
          "ACP_BACKEND_UNSUPPORTED_CONTROL",
          `ACP backend "${handle.backend || meta.backend}" does not accept config key "${key}".`,
        );
      }

      await withAcpRuntimeErrorBoundary({
        run: async () =>
          await runtime.setConfigOption!({
            handle,
            key,
            value,
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP runtime config option.",
      });

      const nextOptions = mergeRuntimeOptions({
        current: resolveRuntimeOptionsFromMeta(meta),
        patch: inferredPatch,
      });
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        options: nextOptions,
      });
      return nextOptions;
    });
  }

  async updateSessionRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    patch: Partial<AcpSessionRuntimeOptions>;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = normalizeSessionKey(params.sessionKey);
    const validatedPatch = validateRuntimeOptionPatch(params.patch);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }

    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      if (resolution.kind === "none") {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${sessionKey}`,
        );
      }
      if (resolution.kind === "stale") {
        throw resolution.error;
      }
      const nextOptions = mergeRuntimeOptions({
        current: resolveRuntimeOptionsFromMeta(resolution.meta),
        patch: validatedPatch,
      });
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        options: nextOptions,
      });
      return nextOptions;
    });
  }

  async resetSessionRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      if (resolution.kind === "none") {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${sessionKey}`,
        );
      }
      if (resolution.kind === "stale") {
        throw resolution.error;
      }
      const { runtime, handle } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolution.meta,
      });
      await withAcpRuntimeErrorBoundary({
        run: async () =>
          await runtime.close({
            handle,
            reason: "reset-runtime-options",
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not reset ACP runtime options.",
      });
      this.clearCachedRuntimeState(sessionKey);
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        options: {},
      });
      return {};
    });
  }

  async runTurn(input: AcpRunTurnInput): Promise<void> {
    const sessionKey = normalizeSessionKey(input.sessionKey);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles({ cfg: input.cfg });
    await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: input.cfg,
        sessionKey,
      });
      if (resolution.kind === "none") {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${sessionKey}`,
        );
      }
      if (resolution.kind === "stale") {
        throw resolution.error;
      }

      const {
        runtime,
        handle: ensuredHandle,
        meta: ensuredMeta,
      } = await this.ensureRuntimeHandle({
        cfg: input.cfg,
        sessionKey,
        meta: resolution.meta,
      });
      let handle = ensuredHandle;
      const meta = ensuredMeta;
      await this.applyRuntimeControls({
        sessionKey,
        runtime,
        handle,
        meta,
      });
      const turnStartedAt = Date.now();
      const actorKey = normalizeActorKey(sessionKey);

      await this.setSessionState({
        cfg: input.cfg,
        sessionKey,
        state: "running",
        clearLastError: true,
      });

      const internalAbortController = new AbortController();
      const onCallerAbort = () => {
        internalAbortController.abort();
      };
      if (input.signal?.aborted) {
        internalAbortController.abort();
      } else if (input.signal) {
        input.signal.addEventListener("abort", onCallerAbort, { once: true });
      }

      const activeTurn: ActiveTurnState = {
        runtime,
        handle,
        abortController: internalAbortController,
      };
      this.activeTurnBySession.set(actorKey, activeTurn);

      let streamError: AcpRuntimeError | null = null;
      try {
        const combinedSignal =
          input.signal && typeof AbortSignal.any === "function"
            ? AbortSignal.any([input.signal, internalAbortController.signal])
            : internalAbortController.signal;
        for await (const event of runtime.runTurn({
          handle,
          text: input.text,
          mode: input.mode,
          requestId: input.requestId,
          signal: combinedSignal,
        })) {
          if (event.type === "error") {
            streamError = new AcpRuntimeError(
              normalizeAcpErrorCode(event.code),
              event.message?.trim() || "ACP turn failed before completion.",
            );
          }
          if (input.onEvent) {
            await input.onEvent(event);
          }
        }
        if (streamError) {
          throw streamError;
        }
        this.recordTurnCompletion({
          startedAt: turnStartedAt,
        });
        await this.setSessionState({
          cfg: input.cfg,
          sessionKey,
          state: "idle",
          clearLastError: true,
        });
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP turn failed before completion.",
        });
        this.recordTurnCompletion({
          startedAt: turnStartedAt,
          errorCode: acpError.code,
        });
        await this.setSessionState({
          cfg: input.cfg,
          sessionKey,
          state: "error",
          lastError: acpError.message,
        });
        throw acpError;
      } finally {
        if (input.signal) {
          input.signal.removeEventListener("abort", onCallerAbort);
        }
        if (this.activeTurnBySession.get(actorKey) === activeTurn) {
          this.activeTurnBySession.delete(actorKey);
        }
        if (meta.mode !== "oneshot") {
          ({ handle } = await this.reconcileRuntimeSessionIdentifiers({
            cfg: input.cfg,
            sessionKey,
            runtime,
            handle,
            meta,
            failOnStatusError: false,
          }));
        }
        if (meta.mode === "oneshot") {
          try {
            await runtime.close({
              handle,
              reason: "oneshot-complete",
            });
          } catch (error) {
            logVerbose(`acp-manager: ACP oneshot close failed for ${sessionKey}: ${String(error)}`);
          } finally {
            this.clearCachedRuntimeState(sessionKey);
          }
        }
      }
    });
  }

  async cancelSession(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    reason?: string;
  }): Promise<void> {
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    const actorKey = normalizeActorKey(sessionKey);
    const activeTurn = this.activeTurnBySession.get(actorKey);
    if (activeTurn) {
      activeTurn.abortController.abort();
      if (!activeTurn.cancelPromise) {
        activeTurn.cancelPromise = activeTurn.runtime.cancel({
          handle: activeTurn.handle,
          reason: params.reason,
        });
      }
      await withAcpRuntimeErrorBoundary({
        run: async () => await activeTurn.cancelPromise!,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP cancel failed before completion.",
      });
      return;
    }

    await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      if (resolution.kind === "none") {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${sessionKey}`,
        );
      }
      if (resolution.kind === "stale") {
        throw resolution.error;
      }
      const { runtime, handle } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolution.meta,
      });
      try {
        await withAcpRuntimeErrorBoundary({
          run: async () =>
            await runtime.cancel({
              handle,
              reason: params.reason,
            }),
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP cancel failed before completion.",
        });
        await this.setSessionState({
          cfg: params.cfg,
          sessionKey,
          state: "idle",
          clearLastError: true,
        });
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP cancel failed before completion.",
        });
        await this.setSessionState({
          cfg: params.cfg,
          sessionKey,
          state: "error",
          lastError: acpError.message,
        });
        throw acpError;
      }
    });
  }

  async closeSession(input: AcpCloseSessionInput): Promise<AcpCloseSessionResult> {
    const sessionKey = normalizeSessionKey(input.sessionKey);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles({ cfg: input.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: input.cfg,
        sessionKey,
      });
      if (resolution.kind === "none") {
        if (input.requireAcpSession ?? true) {
          throw new AcpRuntimeError(
            "ACP_SESSION_INIT_FAILED",
            `Session is not ACP-enabled: ${sessionKey}`,
          );
        }
        return {
          runtimeClosed: false,
          metaCleared: false,
        };
      }
      if (resolution.kind === "stale") {
        if (input.requireAcpSession ?? true) {
          throw resolution.error;
        }
        return {
          runtimeClosed: false,
          metaCleared: false,
        };
      }

      let runtimeClosed = false;
      let runtimeNotice: string | undefined;
      try {
        const { runtime, handle } = await this.ensureRuntimeHandle({
          cfg: input.cfg,
          sessionKey,
          meta: resolution.meta,
        });
        await withAcpRuntimeErrorBoundary({
          run: async () =>
            await runtime.close({
              handle,
              reason: input.reason,
            }),
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP close failed before completion.",
        });
        runtimeClosed = true;
        this.clearCachedRuntimeState(sessionKey);
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP close failed before completion.",
        });
        if (
          input.allowBackendUnavailable &&
          (acpError.code === "ACP_BACKEND_MISSING" || acpError.code === "ACP_BACKEND_UNAVAILABLE")
        ) {
          // Treat unavailable backends as terminal for this cached handle so it
          // cannot continue counting against maxConcurrentSessions.
          this.clearCachedRuntimeState(sessionKey);
          runtimeNotice = acpError.message;
        } else {
          throw acpError;
        }
      }

      let metaCleared = false;
      if (input.clearMeta) {
        await this.writeSessionMeta({
          cfg: input.cfg,
          sessionKey,
          mutate: (_current, entry) => {
            if (!entry) {
              return null;
            }
            return null;
          },
          failOnError: true,
        });
        metaCleared = true;
      }

      return {
        runtimeClosed,
        runtimeNotice,
        metaCleared,
      };
    });
  }

  private async ensureRuntimeHandle(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    meta: SessionAcpMeta;
  }): Promise<{ runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpMeta }> {
    const agent =
      params.meta.agent?.trim() || resolveAcpAgentFromSessionKey(params.sessionKey, "main");
    const mode = params.meta.mode;
    const runtimeOptions = resolveRuntimeOptionsFromMeta(params.meta);
    const cwd = runtimeOptions.cwd ?? normalizeText(params.meta.cwd);
    const configuredBackend = (params.meta.backend || params.cfg.acp?.backend || "").trim();
    const cached = this.getCachedRuntimeState(params.sessionKey);
    if (cached) {
      const backendMatches = !configuredBackend || cached.backend === configuredBackend;
      const agentMatches = cached.agent === agent;
      const modeMatches = cached.mode === mode;
      const cwdMatches = (cached.cwd ?? "") === (cwd ?? "");
      if (backendMatches && agentMatches && modeMatches && cwdMatches) {
        return {
          runtime: cached.runtime,
          handle: cached.handle,
          meta: params.meta,
        };
      }
      this.clearCachedRuntimeState(params.sessionKey);
    }

    this.enforceConcurrentSessionLimit({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });

    const backend = this.deps.requireRuntimeBackend(configuredBackend || undefined);
    const runtime = backend.runtime;
    const ensured = await withAcpRuntimeErrorBoundary({
      run: async () =>
        await runtime.ensureSession({
          sessionKey: params.sessionKey,
          agent,
          mode,
          cwd,
        }),
      fallbackCode: "ACP_SESSION_INIT_FAILED",
      fallbackMessage: "Could not initialize ACP session runtime.",
    });

    const previousMeta = params.meta;
    const previousIdentity = resolveSessionIdentityFromMeta(previousMeta);
    const now = Date.now();
    const effectiveCwd = normalizeText(ensured.cwd) ?? cwd;
    const nextRuntimeOptions = normalizeRuntimeOptions({
      ...runtimeOptions,
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    });
    const nextIdentity =
      mergeSessionIdentity({
        current: previousIdentity,
        incoming: createIdentityFromEnsure({
          handle: ensured,
          now,
        }),
        now,
      }) ?? previousIdentity;
    const nextHandleIdentifiers = resolveRuntimeHandleIdentifiersFromIdentity(nextIdentity);
    const nextHandle: AcpRuntimeHandle = {
      ...ensured,
      ...(nextHandleIdentifiers.backendSessionId
        ? { backendSessionId: nextHandleIdentifiers.backendSessionId }
        : {}),
      ...(nextHandleIdentifiers.agentSessionId
        ? { agentSessionId: nextHandleIdentifiers.agentSessionId }
        : {}),
    };
    const nextMeta: SessionAcpMeta = {
      backend: ensured.backend || backend.id,
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
      !identityEquals(previousIdentity, nextIdentity) ||
      previousMeta.agent !== nextMeta.agent ||
      previousMeta.cwd !== nextMeta.cwd ||
      !runtimeOptionsEqual(previousMeta.runtimeOptions, nextMeta.runtimeOptions) ||
      hasLegacyAcpIdentityProjection(previousMeta);
    if (shouldPersistMeta) {
      await this.writeSessionMeta({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        mutate: (_current, entry) => {
          if (!entry) {
            return null;
          }
          return nextMeta;
        },
      });
    }
    this.setCachedRuntimeState(params.sessionKey, {
      runtime,
      handle: nextHandle,
      backend: ensured.backend || backend.id,
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
  }

  private async persistRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    options: AcpSessionRuntimeOptions;
  }): Promise<void> {
    const normalized = normalizeRuntimeOptions(params.options);
    const hasOptions = Object.keys(normalized).length > 0;
    await this.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current ?? entry.acp;
        if (!base) {
          return null;
        }
        return {
          backend: base.backend,
          agent: base.agent,
          runtimeSessionName: base.runtimeSessionName,
          ...(base.identity ? { identity: base.identity } : {}),
          mode: base.mode,
          runtimeOptions: hasOptions ? normalized : undefined,
          cwd: normalized.cwd,
          state: base.state,
          lastActivityAt: Date.now(),
          ...(base.lastError ? { lastError: base.lastError } : {}),
        };
      },
      failOnError: true,
    });

    const cached = this.getCachedRuntimeState(params.sessionKey);
    if (!cached) {
      return;
    }
    if ((cached.cwd ?? "") !== (normalized.cwd ?? "")) {
      this.clearCachedRuntimeState(params.sessionKey);
      return;
    }
    // Persisting options does not guarantee this process pushed all controls to the runtime.
    // Force the next turn to reconcile runtime controls from persisted metadata.
    cached.appliedControlSignature = undefined;
  }

  private enforceConcurrentSessionLimit(params: { cfg: OpenClawConfig; sessionKey: string }): void {
    const configuredLimit = params.cfg.acp?.maxConcurrentSessions;
    if (typeof configuredLimit !== "number" || !Number.isFinite(configuredLimit)) {
      return;
    }
    const limit = Math.max(1, Math.floor(configuredLimit));
    const actorKey = normalizeActorKey(params.sessionKey);
    if (this.runtimeCache.has(actorKey)) {
      return;
    }
    const activeCount = this.runtimeCache.size();
    if (activeCount >= limit) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `ACP max concurrent sessions reached (${activeCount}/${limit}).`,
      );
    }
  }

  private recordTurnCompletion(params: { startedAt: number; errorCode?: AcpRuntimeError["code"] }) {
    const durationMs = Math.max(0, Date.now() - params.startedAt);
    this.turnLatencyStats.totalMs += durationMs;
    this.turnLatencyStats.maxMs = Math.max(this.turnLatencyStats.maxMs, durationMs);
    if (params.errorCode) {
      this.turnLatencyStats.failed += 1;
      this.recordErrorCode(params.errorCode);
      return;
    }
    this.turnLatencyStats.completed += 1;
  }

  private recordErrorCode(code: string): void {
    const normalized = normalizeAcpErrorCode(code);
    this.errorCountsByCode.set(normalized, (this.errorCountsByCode.get(normalized) ?? 0) + 1);
  }

  private async evictIdleRuntimeHandles(params: { cfg: OpenClawConfig }): Promise<void> {
    const idleTtlMs = resolveRuntimeIdleTtlMs(params.cfg);
    if (idleTtlMs <= 0 || this.runtimeCache.size() === 0) {
      return;
    }
    const now = Date.now();
    const candidates = this.runtimeCache.collectIdleCandidates({
      maxIdleMs: idleTtlMs,
      now,
    });
    if (candidates.length === 0) {
      return;
    }

    for (const candidate of candidates) {
      await this.actorQueue.run(candidate.actorKey, async () => {
        if (this.activeTurnBySession.has(candidate.actorKey)) {
          return;
        }
        const lastTouchedAt = this.runtimeCache.getLastTouchedAt(candidate.actorKey);
        if (lastTouchedAt == null || now - lastTouchedAt < idleTtlMs) {
          return;
        }
        const cached = this.runtimeCache.peek(candidate.actorKey);
        if (!cached) {
          return;
        }
        this.runtimeCache.clear(candidate.actorKey);
        this.evictedRuntimeCount += 1;
        this.lastEvictedAt = Date.now();
        try {
          await cached.runtime.close({
            handle: cached.handle,
            reason: "idle-evicted",
          });
        } catch (error) {
          logVerbose(
            `acp-manager: idle eviction close failed for ${candidate.state.handle.sessionKey}: ${String(error)}`,
          );
        }
      });
    }
  }

  private async resolveRuntimeCapabilities(params: {
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities> {
    return await resolveManagerRuntimeCapabilities(params);
  }

  private async applyRuntimeControls(params: {
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
  }): Promise<void> {
    await applyManagerRuntimeControls({
      ...params,
      getCachedRuntimeState: (sessionKey) => this.getCachedRuntimeState(sessionKey),
    });
  }

  private async setSessionState(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    state: SessionAcpMeta["state"];
    lastError?: string;
    clearLastError?: boolean;
  }): Promise<void> {
    await this.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current ?? entry.acp;
        if (!base) {
          return null;
        }
        const next: SessionAcpMeta = {
          backend: base.backend,
          agent: base.agent,
          runtimeSessionName: base.runtimeSessionName,
          ...(base.identity ? { identity: base.identity } : {}),
          mode: base.mode,
          ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
          ...(base.cwd ? { cwd: base.cwd } : {}),
          state: params.state,
          lastActivityAt: Date.now(),
          ...(base.lastError ? { lastError: base.lastError } : {}),
        };
        if (params.lastError?.trim()) {
          next.lastError = params.lastError.trim();
        } else if (params.clearLastError) {
          delete next.lastError;
        }
        return next;
      },
    });
  }

  private async reconcileRuntimeSessionIdentifiers(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    runtimeStatus?: AcpRuntimeStatus;
    failOnStatusError: boolean;
  }): Promise<{
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    runtimeStatus?: AcpRuntimeStatus;
  }> {
    return await reconcileManagerRuntimeSessionIdentifiers({
      ...params,
      setCachedHandle: (sessionKey, handle) => {
        const cached = this.getCachedRuntimeState(sessionKey);
        if (cached) {
          cached.handle = handle;
        }
      },
      writeSessionMeta: async (writeParams) => await this.writeSessionMeta(writeParams),
    });
  }

  private async writeSessionMeta(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    mutate: (
      current: SessionAcpMeta | undefined,
      entry: SessionEntry | undefined,
    ) => SessionAcpMeta | null | undefined;
    failOnError?: boolean;
  }): Promise<SessionEntry | null> {
    try {
      return await this.deps.upsertSessionMeta({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        mutate: params.mutate,
      });
    } catch (error) {
      if (params.failOnError) {
        throw error;
      }
      logVerbose(
        `acp-manager: failed persisting ACP metadata for ${params.sessionKey}: ${String(error)}`,
      );
      return null;
    }
  }

  private async withSessionActor<T>(sessionKey: string, op: () => Promise<T>): Promise<T> {
    const actorKey = normalizeActorKey(sessionKey);
    return await this.actorQueue.run(actorKey, op);
  }

  private getCachedRuntimeState(sessionKey: string): CachedRuntimeState | null {
    return this.runtimeCache.get(normalizeActorKey(sessionKey));
  }

  private setCachedRuntimeState(sessionKey: string, state: CachedRuntimeState): void {
    this.runtimeCache.set(normalizeActorKey(sessionKey), state);
  }

  private clearCachedRuntimeState(sessionKey: string): void {
    this.runtimeCache.clear(normalizeActorKey(sessionKey));
  }
}
