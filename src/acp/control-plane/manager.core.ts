import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { toErrorObject } from "../../infra/errors.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  captureSessionTarget,
  getCurrentSessionControllerClaim,
  getCurrentSessionControllerOwner,
} from "../../sessions/session-controller.lifecycle.js";
import {
  captureSessionControllerProducers,
  registerSessionControllerProducer,
} from "../../sessions/session-controller.producer-custody.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import { resolveSessionStorePathForAcp } from "../runtime/session-meta-store.js";
import {
  publishManagerCancelledTurnBeforeStart,
  runManagerCancelSession,
} from "./manager.cancel-session.js";
import { runManagerCloseSession } from "./manager.close-session.js";
import { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile.js";
import { runManagerInitializeSession } from "./manager.initialize-session.js";
import { registerAcpSessionManagerDisposer } from "./manager.lifecycle.js";
import { registerAcpSessionResetControls } from "./manager.reset-controls.js";
import { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { ensureManagerRuntimeHandle } from "./manager.runtime-handle-ensure.js";
import {
  runResetManagerSessionRuntimeOptions,
  runSetManagerSessionRuntimeOption,
  runUpdateManagerSessionRuntimeOptions,
  type RuntimeOptionCommandServices,
} from "./manager.runtime-options-commands.js";
import { runManagerStartupIdentityReconcile } from "./manager.startup-identity-reconcile.js";
import { runManagerGetSessionStatus } from "./manager.status.js";
import { runManagerTurn } from "./manager.turn-runner.js";
import {
  DEFAULT_DEPS,
  type AcpCancelSessionInput,
  type AcpCloseSessionInput,
  type AcpCloseSessionResult,
  type AcpInitializeSessionInput,
  type AcpManagerObservabilitySnapshot,
  type AcpRunTurnInput,
  type AcpSessionManagerDeps,
  type AcpSessionResolution,
  type AcpSessionRuntimeOptions,
  type AcpSessionStatus,
  type AcpSessionTarget,
  type AcpStartupIdentityReconcileResult,
  type ActiveTurnState,
  type EnsureManagerRuntimeHandle,
  type ReconcileManagerRuntimeSessionIdentifiers,
  type SessionAcpMeta,
  type SessionEntry,
  type SetManagerSessionState,
  type TurnLatencyStats,
  type WriteManagerSessionMeta,
} from "./manager.types.js";
import {
  createSupersededActorError,
  acpSessionActorKey,
  normalizeAcpErrorCode,
  resolveAcpSessionTarget,
  resolveStoredAcpSession,
} from "./manager.utils.js";
import {
  normalizeText,
  validateRuntimeConfigOptionInput,
  validateRuntimeModeInput,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";
import { SessionActorQueue } from "./session-actor-queue.js";

export class AcpSessionManager {
  private readonly actorQueue = new SessionActorQueue();
  private readonly runtimeHandles = new ManagerRuntimeHandleCache();
  private readonly activeTurnBySession = new Map<string, ActiveTurnState>();
  // Live runTurn instances per actor and request ID; the run ID's terminal signal belongs to
  // whichever same-ID instance actually reaches a terminal state, never to a cancelled duplicate.
  private readonly liveTurnRequests = new Map<string, number>();
  // Disposal aborts in-flight and later turns of this retired instance.
  private readonly lifecycle = new AbortController();
  private readonly producerOwner = {};
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
    registerAcpSessionResetControls(this, {
      captureSessionRuntimeOwnership: (params) => {
        const ownership = this.actorQueue.capture(
          acpSessionActorKey(resolveAcpSessionTarget(params)),
        );
        return { isCurrent: ownership.isCurrent, release: ownership.release };
      },
      forceDiscardSessionRuntime: (params) => this.#forceDiscardSessionRuntime(params),
    });
    registerAcpSessionManagerDisposer(this, async (reason) => {
      this.lifecycle.abort();
      await Promise.allSettled(
        captureSessionControllerProducers({ owner: this.producerOwner }).map(
          (producer) => producer.settled,
        ),
      );
      await this.runtimeHandles.closeAll({ actorQueue: this.actorQueue, reason });
      this.activeTurnBySession.clear();
    });
  }

  /** @deprecated Use resolveSessionAsync; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
  resolveSession(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
  }): AcpSessionResolution {
    warnPluginSdkDeprecation({
      family: "acp-session",
      method: "AcpSessionManager.resolveSession",
      replacement: "AcpSessionManager.resolveSessionAsync",
    });
    if (!params.sessionKey.trim()) {
      return { kind: "none", sessionKey: "" };
    }
    const target = resolveAcpSessionTarget(params);
    return resolveStoredAcpSession(
      target,
      this.deps.loadSessionEntry({ cfg: params.cfg, ...target, clone: false }),
    );
  }

  async resolveSessionAsync(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    assertCurrent?: () => void;
  }): Promise<AcpSessionResolution> {
    params.assertCurrent?.();
    if (!params.sessionKey.trim()) {
      return { kind: "none", sessionKey: "" };
    }
    const target = resolveAcpSessionTarget(params);
    const stored = await this.deps.loadSessionEntryAsync({
      cfg: params.cfg,
      ...target,
      clone: false,
      ...(params.assertCurrent ? { assertCurrent: params.assertCurrent } : {}),
    });
    params.assertCurrent?.();
    return resolveStoredAcpSession(target, stored);
  }

  getObservabilitySnapshot(): AcpManagerObservabilitySnapshot {
    const completedTurns = this.turnLatencyStats.completed + this.turnLatencyStats.failed;
    const averageLatencyMs =
      completedTurns > 0 ? Math.round(this.turnLatencyStats.totalMs / completedTurns) : 0;
    return {
      runtimeCache: this.runtimeHandles.getObservabilitySnapshot(),
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
    return await runManagerStartupIdentityReconcile({
      cfg: params.cfg,
      deps: this.deps,
      withSessionActor: this.withSessionActor.bind(this),
      resolveSession: this.resolveSessionAsync.bind(this),
      ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
      reconcileRuntimeSessionIdentifiers: this.reconcileRuntimeSessionIdentifiers.bind(this),
    });
  }

  async initializeSession(input: AcpInitializeSessionInput): Promise<{
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    sessionEntry: SessionEntry;
    closeRuntimeOnFailure: () => Promise<void>;
  }> {
    const target = resolveAcpSessionTarget(input);
    return await this.withSessionActor(target, async (isCurrentActor) => {
      const initialized = await runManagerInitializeSession({
        input,
        ...target,
        deps: this.deps,
        runtimeHandles: this.runtimeHandles,
        writeSessionMeta: this.writeSessionMeta.bind(this),
        isCurrentActor,
      });
      return {
        ...initialized,
        // Deletion and shutdown may have already released this exact handle.
        closeRuntimeOnFailure: () =>
          this.withSessionActor(target, () =>
            this.runtimeHandles.close({
              ...target,
              reason: "spawn-failed",
              expectedHandle: initialized.handle,
            }),
          ),
      };
    });
  }

  async getSessionStatus(params: {
    assertActive?: () => void;
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    signal?: AbortSignal;
  }): Promise<AcpSessionStatus> {
    const target = resolveAcpSessionTarget(params);
    this.throwIfAborted(params.signal);
    return await this.withSessionActor(
      target,
      async (isCurrentActor) =>
        await runManagerGetSessionStatus({
          assertActive: params.assertActive,
          cfg: params.cfg,
          ...target,
          signal: params.signal,
          throwIfAborted: this.throwIfAborted.bind(this),
          resolveSession: this.resolveSessionAsync.bind(this),
          ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
          reconcileRuntimeSessionIdentifiers: this.reconcileRuntimeSessionIdentifiers.bind(this),
          isCurrentActor,
        }),
      params.signal,
    );
  }

  async setSessionRuntimeMode(params: {
    assertActive?: () => void;
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    runtimeMode: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const target = resolveAcpSessionTarget(params);
    const runtimeMode = validateRuntimeModeInput(params.runtimeMode);

    return await this.withSessionActor(target, async (isCurrentActor) => {
      return await runSetManagerSessionRuntimeOption({
        assertActive: params.assertActive,
        cfg: params.cfg,
        ...target,
        update: { runtimeMode },
        ...this.runtimeOptionCommandServices(isCurrentActor),
      });
    });
  }

  async setSessionConfigOption(params: {
    assertActive?: () => void;
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    key: string;
    value: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const target = resolveAcpSessionTarget(params);
    const { key, value } = validateRuntimeConfigOptionInput(params.key, params.value);

    return await this.withSessionActor(target, async (isCurrentActor) => {
      return await runSetManagerSessionRuntimeOption({
        assertActive: params.assertActive,
        cfg: params.cfg,
        ...target,
        update: { key, value },
        ...this.runtimeOptionCommandServices(isCurrentActor),
      });
    });
  }

  async updateSessionRuntimeOptions(params: {
    assertActive?: () => void;
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    patch: Partial<AcpSessionRuntimeOptions>;
  }): Promise<AcpSessionRuntimeOptions> {
    const target = resolveAcpSessionTarget(params);
    const validatedPatch = validateRuntimeOptionPatch(params.patch);

    return await this.withSessionActor(target, async (isCurrentActor) => {
      return await runUpdateManagerSessionRuntimeOptions({
        assertActive: params.assertActive,
        cfg: params.cfg,
        ...target,
        patch: validatedPatch,
        ...this.runtimeOptionCommandServices(isCurrentActor),
      });
    });
  }

  async resetSessionRuntimeOptions(params: {
    assertActive?: () => void;
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const target = resolveAcpSessionTarget(params);
    return await this.withSessionActor(target, async (isCurrentActor) => {
      return await runResetManagerSessionRuntimeOptions({
        assertActive: params.assertActive,
        cfg: params.cfg,
        ...target,
        ...this.runtimeOptionCommandServices(isCurrentActor),
      });
    });
  }

  /**
   * Runs one ACP turn as a session-controller turn on its target session.
   * A same-session caller's turn is inherited; any other caller waits in the target's mailbox.
   */
  async runTurn(input: AcpRunTurnInput): Promise<void> {
    const target = resolveAcpSessionTarget(input);
    const { storePath, storeSessionKey } = resolveSessionStorePathForAcp({
      cfg: input.cfg,
      ...target,
    });
    const producer = registerSessionControllerProducer({
      owner: this.producerOwner,
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey: storeSessionKey,
        agentId: target.agentId,
      }),
      runInstance: input.admittedRunContext.operationalRunInstance,
    });
    const inheritedClaim = getCurrentSessionControllerClaim();
    const inheritedOperation = getCurrentSessionControllerOwner();
    const actor = this.actorQueue.capture(acpSessionActorKey(target));
    const assertCurrent = () => {
      if (!actor.isCurrent()) {
        throw createSupersededActorError(target.sessionKey);
      }
    };
    const startedAt = Date.now();
    const requestKey = `${storePath}\u0000${acpSessionActorKey(target)}\u0000${input.requestId}`;
    this.liveTurnRequests.set(requestKey, (this.liveTurnRequests.get(requestKey) ?? 0) + 1);
    let live = true;
    const leave = (): boolean => {
      if (live) {
        live = false;
        const remaining = (this.liveTurnRequests.get(requestKey) ?? 1) - 1;
        if (remaining > 0) {
          this.liveTurnRequests.set(requestKey, remaining);
        } else {
          this.liveTurnRequests.delete(requestKey);
        }
      }
      return !this.liveTurnRequests.has(requestKey);
    };
    const signal = AbortSignal.any([
      producer.signal,
      this.lifecycle.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    let started = false;
    let cancelled = signal.aborted;
    let terminal: Promise<void> | undefined;
    const publishCancelled = () => {
      terminal ??= publishManagerCancelledTurnBeforeStart({
        input,
        target,
        ownsRunTerminal: leave(),
        assertActorCurrent: assertCurrent,
        prepareSessionControlRead: (controlParams) =>
          this.deps.prepareSessionControlRead(controlParams),
      }).then(() => {
        this.recordTurnCompletion({ startedAt });
      });
      return terminal;
    };
    try {
      // The mailbox reservation is synchronous, preserving arrival order. Its settlement
      // owns queued terminal persistence so Stop cannot acknowledge an unfinished writer.
      await withSessionTurn(
        {
          ...target,
          storePath,
          abortSignal: signal,
          onCancelled: () => {
            cancelled = true;
          },
          onSettled: async () => {
            if (!started && (cancelled || signal.aborted)) {
              await publishCancelled();
            }
          },
        },
        async (_operation, turnSignal) => {
          producer.retainCleanupForSources(getCurrentSessionControllerClaim()?.inputs ?? []);
          try {
            await this.withSessionActor(
              target,
              async (isCurrentActor) => {
                started = true;
                await runManagerTurn({
                  input: { ...input, signal: turnSignal },
                  ...target,
                  runtimeHandles: this.runtimeHandles,
                  activeTurnBySession: this.activeTurnBySession,
                  resolveSession: this.resolveSessionAsync.bind(this),
                  prepareSessionControlRead: this.deps.prepareSessionControlRead,
                  ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
                  setSessionState: this.setSessionState.bind(this),
                  recordTurnCompletion: this.recordTurnCompletion.bind(this),
                  reconcileRuntimeSessionIdentifiers:
                    this.reconcileRuntimeSessionIdentifiers.bind(this),
                  writeSessionMeta: this.writeSessionMeta.bind(this),
                  isCurrentActor,
                  producer,
                  ownsTurnTerminal:
                    getCurrentSessionControllerClaim() !== inheritedClaim ||
                    (_operation !== undefined && _operation !== inheritedOperation),
                });
              },
              turnSignal,
            );
          } catch (error) {
            if (started || !turnSignal.aborted) {
              throw error;
            }
            cancelled = true;
            await publishCancelled();
          }
        },
      );
    } catch (error) {
      if (started || !(cancelled || signal.aborted || isAbortError(error))) {
        throw error;
      }
      try {
        await publishCancelled();
      } catch (publicationError) {
        producer.recordCancellationFailure(publicationError);
        throw publicationError;
      }
    } finally {
      leave();
      actor.release();
      producer.release();
    }
  }

  /** Cancels captured ACP invocations, or the idle backend when no turn was accepted. */
  async cancelSession(input: AcpCancelSessionInput): Promise<void> {
    await runManagerCancelSession({
      ...input,
      producerOwner: this.producerOwner,
      withSessionActor: this.withSessionActor.bind(this),
      resolveSession: this.resolveSessionAsync.bind(this),
      prepareSessionControlRead: this.deps.prepareSessionControlRead,
      ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
      runtimeHandles: this.runtimeHandles,
      setSessionState: this.setSessionState.bind(this),
    });
  }

  /** Evicts only the captured runtime generation; old handles close in the background. */
  async #forceDiscardSessionRuntime(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    reason: string;
    isCurrent?: () => boolean;
    assertCurrent?: () => void;
  }): Promise<void> {
    params.assertCurrent?.();
    if (params.isCurrent && !params.isCurrent()) {
      throw createSupersededActorError(params.sessionKey);
    }
    const target = resolveAcpSessionTarget(params);
    const { sessionKey } = target;
    const actorKey = acpSessionActorKey(target);
    this.actorQueue.rotate(actorKey);
    const activeTurn = this.activeTurnBySession.get(actorKey);
    if (activeTurn) {
      activeTurn.abortController.abort();
      if (this.activeTurnBySession.get(actorKey) === activeTurn) {
        this.activeTurnBySession.delete(actorKey);
      }
    }
    const cached = this.runtimeHandles.take(target);
    const closeTargets = [
      ...(activeTurn ? [{ runtime: activeTurn.runtime, handle: activeTurn.handle }] : []),
      ...(cached &&
      (!activeTurn || !this.runtimeHandles.handlesMatch(cached.handle, activeTurn.handle))
        ? [{ runtime: cached.runtime, handle: cached.handle }]
        : []),
    ];
    void Promise.allSettled(
      closeTargets.map(async ({ runtime, handle }) => {
        await runtime.close({
          handle,
          reason: params.reason,
          discardPersistentState: true,
        });
      }),
    ).then((outcomes) => {
      const failed = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failed) {
        logVerbose(
          `acp-manager: force-discard runtime close failed for ${sessionKey}: ${String(failed.reason)}`,
        );
      }
    });
  }

  async closeSession(input: AcpCloseSessionInput): Promise<AcpCloseSessionResult> {
    const capturedInput = {
      ...input,
      expectedControlBinding: input.expectedControlBinding
        ? { ...input.expectedControlBinding }
        : undefined,
    };
    const target = resolveAcpSessionTarget(capturedInput);
    return await this.withSessionActor(
      target,
      async (isCurrentActor) =>
        await runManagerCloseSession({
          input: capturedInput,
          ...target,
          deps: this.deps,
          runtimeHandles: this.runtimeHandles,
          resolveSession: this.resolveSessionAsync.bind(this),
          ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
          writeSessionMeta: this.writeSessionMeta.bind(this),
          isCurrentActor,
        }),
    );
  }

  private async ensureRuntimeHandle(
    params: Parameters<EnsureManagerRuntimeHandle>[0],
  ): ReturnType<EnsureManagerRuntimeHandle> {
    return await ensureManagerRuntimeHandle({
      ...params,
      deps: this.deps,
      runtimeHandles: this.runtimeHandles,
      writeSessionMeta: this.writeSessionMeta.bind(this),
    });
  }

  private runtimeOptionCommandServices(
    isCurrentActor: () => boolean,
  ): RuntimeOptionCommandServices {
    return {
      runtimeHandles: this.runtimeHandles,
      resolveSession: this.resolveSessionAsync.bind(this),
      ensureRuntimeHandle: this.ensureRuntimeHandle.bind(this),
      writeSessionMeta: this.writeSessionMeta.bind(this),
      isCurrentActor,
    };
  }

  private recordTurnCompletion(params: { startedAt: number; errorCode?: AcpRuntimeError["code"] }) {
    const durationMs = Math.max(0, Date.now() - params.startedAt);
    this.turnLatencyStats.totalMs += durationMs;
    this.turnLatencyStats.maxMs = Math.max(this.turnLatencyStats.maxMs, durationMs);
    if (params.errorCode) {
      this.turnLatencyStats.failed += 1;
      const code = normalizeAcpErrorCode(params.errorCode);
      this.errorCountsByCode.set(code, (this.errorCountsByCode.get(code) ?? 0) + 1);
      return;
    }
    this.turnLatencyStats.completed += 1;
  }

  private async setSessionState(
    params: Parameters<SetManagerSessionState>[0],
  ): ReturnType<SetManagerSessionState> {
    await this.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      skipMaintenance: true,
      takeCacheOwnership: true,
      isCurrentActor: params.isCurrentActor,
      assertCommitAllowed: params.assertCurrent,
      failOnError: params.assertCurrent !== undefined,
      acpControl: params.acpControl,
      mutate: (base, entry) => {
        params.assertCurrent?.();
        if (!entry || !base) {
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

  private async reconcileRuntimeSessionIdentifiers(
    params: Parameters<ReconcileManagerRuntimeSessionIdentifiers>[0],
  ): ReturnType<ReconcileManagerRuntimeSessionIdentifiers> {
    return await reconcileManagerRuntimeSessionIdentifiers({
      ...params,
      setCachedHandle: (target, handle) => {
        const cached = this.runtimeHandles.get(target);
        if (cached) {
          cached.handle = handle;
        }
      },
      writeSessionMeta: this.writeSessionMeta.bind(this),
    });
  }

  private async writeSessionMeta(
    params: Parameters<WriteManagerSessionMeta>[0],
  ): ReturnType<WriteManagerSessionMeta> {
    try {
      const input: Parameters<AcpSessionManagerDeps["upsertSessionMeta"]>[0] = {
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        mutate: params.mutate,
        ...(params.expectedControlBinding
          ? { expectedControlBinding: params.expectedControlBinding }
          : {}),
        assertCommitAllowed: () => {
          params.assertCommitAllowed?.();
          if (params.isCurrentActor && !params.isCurrentActor()) {
            throw createSupersededActorError(params.sessionKey);
          }
        },
        ...(params.skipMaintenance === true ? { skipMaintenance: true } : {}),
        ...(params.takeCacheOwnership === true ? { takeCacheOwnership: true } : {}),
      };
      return params.acpControl
        ? await this.deps.upsertSessionMetaForControl(input, params.acpControl)
        : await this.deps.upsertSessionMeta(input);
    } catch (error) {
      if (params.isCurrentActor && !params.isCurrentActor()) {
        throw createSupersededActorError(params.sessionKey);
      }
      if (params.failOnError || error instanceof AgentSelectionRequiredError) {
        throw error;
      }
      logVerbose(
        `acp-manager: failed persisting ACP metadata for ${params.sessionKey}: ${String(error)}`,
      );
      return null;
    }
  }

  private async withSessionActor<T>(
    target: AcpSessionTarget,
    op: (isCurrentActor: () => boolean) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const actorKey = acpSessionActorKey(target);
    this.throwIfAborted(signal);

    let actorStarted = false;
    const queued = this.actorQueue.run(actorKey, async (isCurrentActor) => {
      actorStarted = true;
      this.throwIfAborted(signal);
      return await op(isCurrentActor);
    });
    if (!signal) {
      return await queued;
    }

    const outcome = createDeferredCore<T>();
    const onAbort = () => {
      if (actorStarted) {
        return;
      }
      try {
        this.throwIfAborted(signal);
      } catch (error) {
        outcome.reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void queued.then(outcome.resolve, (error: unknown) =>
      outcome.reject(toErrorObject(error, "Non-Error rejection")),
    );
    if (signal.aborted) {
      onAbort();
    }
    try {
      return await outcome.promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) {
      return;
    }
    throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP operation aborted.");
  }
}
