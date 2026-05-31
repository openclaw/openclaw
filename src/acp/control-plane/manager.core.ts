import {
  createIdentityFromEnsure,
  identityHasStableSessionId,
  isSessionIdentityPending,
  mergeSessionIdentity,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "@openclaw/acp-core/runtime/types";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import {
  AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile.js";
import {
  applyManagerRuntimeControls,
  resolveManagerRuntimeCapabilities,
} from "./manager.runtime-controls.js";
import { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { ensureManagerRuntimeHandle } from "./manager.runtime-handle-ensure.js";
import {
  discardPersistedManagerRuntimeState,
  isRecoverableManagerAcpxExitError,
  tryPrepareFreshManagerRuntimeSession,
} from "./manager.runtime-resume-state.js";
import { runManagerTurn } from "./manager.turn-runner.js";
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
  canonicalizeAcpSessionKey,
  createUnsupportedControlError,
  normalizeAcpErrorCode,
  normalizeActorKey,
  requireReadySessionMeta,
  resolveAcpSessionResolutionError,
  resolveMissingMetaError,
} from "./manager.utils.js";
import {
  inferRuntimeOptionPatchFromConfigOption,
  mergeRuntimeOptions,
  normalizeRuntimeOptions,
  normalizeText,
  resolveRuntimeConfigOptionKey,
  resolveRuntimeOptionsFromMeta,
  validateRuntimeConfigOptionInput,
  validateRuntimeModeInput,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";
import { SessionActorQueue } from "./session-actor-queue.js";

export class AcpSessionManager {
  private readonly actorQueue = new SessionActorQueue();
  private readonly runtimeHandles = new ManagerRuntimeHandleCache();
  private readonly activeTurnBySession = new Map<string, ActiveTurnState>();
  private readonly turnLatencyStats: TurnLatencyStats = {
    completed: 0,
    failed: 0,
    totalMs: 0,
    maxMs: 0,
  };
  private readonly errorCountsByCode = new Map<string, number>();
  private readonly deps: AcpSessionManagerDeps;

  constructor(deps: AcpSessionManagerDeps = DEFAULT_DEPS) {
    this.deps = deps;
  }

  resolveSession(params: { cfg: OpenClawConfig; sessionKey: string }): AcpSessionResolution {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      return {
        kind: "none",
        sessionKey,
      };
    }
    const acp = this.deps.readSessionEntry({
      cfg: params.cfg,
      sessionKey,
      clone: false,
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
      runtimeCache: this.runtimeHandles.getObservabilitySnapshot(cfg),
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
      if (
        !isSessionIdentityPending(currentIdentity) ||
        !identityHasStableSessionId(currentIdentity)
      ) {
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
    const sessionKey = canonicalizeAcpSessionKey({
      cfg: input.cfg,
      sessionKey: input.sessionKey,
    });
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const agent = normalizeAgentId(input.agent);
    await this.evictIdleRuntimeHandles(input.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      const backend = this.deps.requireRuntimeBackend(input.backendId || input.cfg.acp?.backend);
      const runtime = backend.runtime;
      const initialRuntimeOptions = validateRuntimeOptionPatch({
        ...input.runtimeOptions,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      });
      const requestedCwd = initialRuntimeOptions.cwd;
      const requestedModel = initialRuntimeOptions.model;
      const requestedThinking = initialRuntimeOptions.thinking;
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
            resumeSessionId: input.resumeSessionId,
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(requestedThinking ? { thinking: requestedThinking } : {}),
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

      let persisted: SessionEntry | null = null;
      try {
        persisted = await this.writeSessionMeta({
          cfg: input.cfg,
          sessionKey,
          mutate: () => meta,
          failOnError: true,
        });
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

      if (!persisted?.acp) {
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

        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Could not persist ACP metadata for ${sessionKey}.`,
        );
      }
      this.runtimeHandles.set(sessionKey, {
        runtime,
        handle,
        backend: handle.backend || backend.id,
        agent,
        mode: input.mode,
        cwd: effectiveCwd,
        configSignature: resolveRuntimeConfigCacheKey(input.cfg),
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
    signal?: AbortSignal;
  }): Promise<AcpSessionStatus> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    this.throwIfAborted(params.signal);
    await this.evictIdleRuntimeHandles(params.cfg);
    return await this.withSessionActor(
      sessionKey,
      async () => {
        this.throwIfAborted(params.signal);
        const resolution = this.resolveSession({
          cfg: params.cfg,
          sessionKey,
        });
        const resolvedMeta = requireReadySessionMeta(resolution);
        const {
          runtime,
          handle: ensuredHandle,
          meta: ensuredMeta,
        } = await this.ensureRuntimeHandle({
          cfg: params.cfg,
          sessionKey,
          meta: resolvedMeta,
        });
        let handle = ensuredHandle;
        let meta = ensuredMeta;
        const capabilities = await this.resolveRuntimeCapabilities({ runtime, handle });
        let runtimeStatus: AcpRuntimeStatus | undefined;
        if (runtime.getStatus) {
          runtimeStatus = await withAcpRuntimeErrorBoundary({
            run: async () => {
              this.throwIfAborted(params.signal);
              const status = await runtime.getStatus!({
                handle,
                ...(params.signal ? { signal: params.signal } : {}),
              });
              this.throwIfAborted(params.signal);
              return status;
            },
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
      },
      params.signal,
    );
  }

  async setSessionRuntimeMode(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    runtimeMode: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const runtimeMode = validateRuntimeModeInput(params.runtimeMode);

    await this.evictIdleRuntimeHandles(params.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle, meta } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolvedMeta,
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
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const normalizedOption = validateRuntimeConfigOptionInput(params.key, params.value);
    const key = normalizedOption.key;
    const value = normalizedOption.value;

    await this.evictIdleRuntimeHandles(params.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle, meta } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolvedMeta,
      });
      const inferredPatch = inferRuntimeOptionPatchFromConfigOption(key, value);
      const capabilities = await this.resolveRuntimeCapabilities({
        runtime,
        handle,
        includeStatusConfigOptionKeys: true,
      });
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
          .map((entry) => normalizeLowercaseStringOrEmpty(entry))
          .filter(Boolean),
      );
      const wireKey = resolveRuntimeConfigOptionKey(key, capabilities.configOptionKeys);
      if (
        advertisedKeys.size > 0 &&
        !advertisedKeys.has(normalizeLowercaseStringOrEmpty(wireKey))
      ) {
        throw new AcpRuntimeError(
          "ACP_BACKEND_UNSUPPORTED_CONTROL",
          `ACP backend "${handle.backend || meta.backend}" does not accept config key "${wireKey}".`,
        );
      }

      await withAcpRuntimeErrorBoundary({
        run: async () =>
          await runtime.setConfigOption!({
            handle,
            key: wireKey,
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
    const sessionKey = canonicalizeAcpSessionKey(params);
    const validatedPatch = validateRuntimeOptionPatch(params.patch);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }

    await this.evictIdleRuntimeHandles(params.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const nextOptions = mergeRuntimeOptions({
        current: resolveRuntimeOptionsFromMeta(resolvedMeta),
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
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles(params.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolvedMeta,
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
      this.runtimeHandles.clear(sessionKey);
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        options: {},
      });
      return {};
    });
  }

  async runTurn(input: AcpRunTurnInput): Promise<void> {
    const sessionKey = canonicalizeAcpSessionKey({
      cfg: input.cfg,
      sessionKey: input.sessionKey,
    });
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles(input.cfg);
    await this.withSessionActor(
      sessionKey,
      async () =>
        await runManagerTurn({
          input,
          sessionKey,
          deps: this.deps,
          runtimeHandles: this.runtimeHandles,
          activeTurnBySession: this.activeTurnBySession,
          resolveSession: this.resolveSession.bind(this),
          ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
          applyRuntimeControls: this.applyRuntimeControls.bind(this),
          setSessionState: this.setSessionState.bind(this),
          recordTurnCompletion: this.recordTurnCompletion.bind(this),
          reconcileRuntimeSessionIdentifiers: this.reconcileRuntimeSessionIdentifiers.bind(this),
          writeSessionMeta: this.writeSessionMeta.bind(this),
        }),
      input.signal,
    );
  }

  async cancelSession(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    reason?: string;
  }): Promise<void> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles(params.cfg);
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
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        sessionKey,
        meta: resolvedMeta,
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
    const sessionKey = canonicalizeAcpSessionKey({
      cfg: input.cfg,
      sessionKey: input.sessionKey,
    });
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles(input.cfg);
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: input.cfg,
        sessionKey,
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
        if (input.discardPersistentState) {
          await tryPrepareFreshManagerRuntimeSession({
            deps: this.deps,
            cfg: input.cfg,
            meta,
            sessionKey,
            logPrefix: "acp close fast-reset",
          });
        }
        this.runtimeHandles.clear(sessionKey);
      } else {
        try {
          const { runtime: ensuredRuntime, handle } = await this.ensureRuntimeHandle({
            cfg: input.cfg,
            sessionKey,
            meta,
          });
          await withAcpRuntimeErrorBoundary({
            run: async () =>
              await ensuredRuntime.close({
                handle,
                reason: input.reason,
                discardPersistentState: input.discardPersistentState,
              }),
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "ACP close failed before completion.",
          });
          runtimeClosed = true;
          this.runtimeHandles.clear(sessionKey);
        } catch (error) {
          const acpError = toAcpRuntimeError({
            error,
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "ACP close failed before completion.",
          });
          if (
            input.allowBackendUnavailable &&
            (acpError.code === "ACP_BACKEND_MISSING" ||
              acpError.code === "ACP_BACKEND_UNAVAILABLE" ||
              (input.discardPersistentState && acpError.code === "ACP_SESSION_INIT_FAILED") ||
              (input.discardPersistentState &&
                acpError.code === "ACP_BACKEND_UNSUPPORTED_CONTROL") ||
              isRecoverableManagerAcpxExitError(acpError.message))
          ) {
            if (input.discardPersistentState) {
              await tryPrepareFreshManagerRuntimeSession({
                deps: this.deps,
                cfg: input.cfg,
                meta,
                sessionKey,
                logPrefix: "acp close recovery",
                missingBackendError: acpError,
              });
            }
            // Treat unavailable backends as terminal for this cached handle so it
            // cannot continue counting against maxConcurrentSessions.
            this.runtimeHandles.clear(sessionKey);
            runtimeNotice = acpError.message;
          } else {
            throw acpError;
          }
        }
      }

      let metaCleared = false;
      if (input.discardPersistentState && !input.clearMeta) {
        await discardPersistedManagerRuntimeState({
          cfg: input.cfg,
          sessionKey,
          writeSessionMeta: async (writeParams) => await this.writeSessionMeta(writeParams),
        });
      }

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
    return await ensureManagerRuntimeHandle({
      ...params,
      deps: this.deps,
      runtimeHandles: this.runtimeHandles,
      enforceConcurrentSessionLimit: (limitParams) =>
        this.enforceConcurrentSessionLimit(limitParams),
      writeSessionMeta: async (writeParams) => await this.writeSessionMeta(writeParams),
    });
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
        const base = current;
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

    const cached = this.runtimeHandles.get(params.sessionKey);
    if (!cached) {
      return;
    }
    if ((cached.cwd ?? "") !== (normalized.cwd ?? "")) {
      this.runtimeHandles.clear(params.sessionKey);
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
    if (this.runtimeHandles.has(params.sessionKey)) {
      return;
    }
    const activeCount = this.runtimeHandles.size();
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

  private async resolveRuntimeCapabilities(params: {
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    includeStatusConfigOptionKeys?: boolean;
  }): Promise<AcpRuntimeCapabilities> {
    return await resolveManagerRuntimeCapabilities(params);
  }

  private async evictIdleRuntimeHandles(cfg: OpenClawConfig): Promise<void> {
    await this.runtimeHandles.evictIdle({
      cfg,
      actorQueue: this.actorQueue,
      activeTurnBySession: this.activeTurnBySession,
    });
  }

  private async applyRuntimeControls(params: {
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
  }): Promise<void> {
    await applyManagerRuntimeControls({
      ...params,
      getCachedRuntimeState: (sessionKey) => this.runtimeHandles.get(sessionKey),
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
      skipMaintenance: true,
      takeCacheOwnership: true,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current;
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
        const lastError = normalizeText(params.lastError);
        if (lastError) {
          next.lastError = lastError;
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
        const cached = this.runtimeHandles.get(sessionKey);
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
    skipMaintenance?: boolean;
    takeCacheOwnership?: boolean;
  }): Promise<SessionEntry | null> {
    try {
      return await this.deps.upsertSessionMeta({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        mutate: params.mutate,
        ...(params.skipMaintenance === true ? { skipMaintenance: true } : {}),
        ...(params.takeCacheOwnership === true ? { takeCacheOwnership: true } : {}),
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

  private async withSessionActor<T>(
    sessionKey: string,
    op: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const actorKey = normalizeActorKey(sessionKey);
    this.throwIfAborted(signal);

    let actorStarted = false;
    const queued = this.actorQueue.run(actorKey, async () => {
      actorStarted = true;
      this.throwIfAborted(signal);
      return await op();
    });
    if (!signal) {
      return await queued;
    }

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
      };
      const settleValue = (value: T) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleError = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        if (actorStarted) {
          return;
        }
        try {
          this.throwIfAborted(signal);
        } catch (error) {
          settleError(error);
        }
      };

      signal.addEventListener("abort", onAbort, { once: true });
      queued.then(settleValue, settleError);
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) {
      return;
    }
    throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP operation aborted.");
  }
}
