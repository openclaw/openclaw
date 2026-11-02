import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { expectDefined } from "@openclaw/normalization-core";
import {
  assertOperatorModelAllowed,
  bindOperatorModelExecution,
  readAdmittedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { normalizeModelRef } from "../../agents/model-ref-shared.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { logVerbose } from "../../globals.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import type { SessionControllerProducer } from "../../sessions/session-controller.producer-custody.js";
import { recordSessionHumanDirectMessage } from "../../sessions/session-state-events.js";
import { recordSubagentTerminalState } from "../../sessions/subagent-terminal-state.js";
import { AcpRuntimeError, formatAcpErrorChain, toAcpRuntimeError } from "../runtime/errors.js";
import { matchesAcpSessionRuntimeLocator } from "../runtime/session-control-owner.js";
import type { AcpSessionRuntimeLocator } from "../runtime/session-meta-control.types.js";
import { resolveSessionStorePathForAcp } from "../runtime/session-meta-store.js";
import { markAcpTurnActive } from "./active-turns.js";
import {
  isFailoverWorthyBackendError,
  resolveBackendCandidatePlan,
  type BackendAttempt,
} from "./manager.backend-failover.js";
import { cancelManagerActiveTurn } from "./manager.cancel-session.js";
import { applyManagerRuntimeControls } from "./manager.runtime-controls.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { isAcpOwnerRepairRequired } from "./manager.runtime-owner.js";
import { prepareFreshManagerRuntimeHandleRetry } from "./manager.runtime-resume-state.js";
import { consumeAcpTurnStream } from "./manager.turn-stream.js";
import {
  ACP_TURN_TIMEOUT_DETAIL_CODE,
  awaitTurnWithTimeout,
  cleanupTimedOutTurn,
  resolveTurnTimeoutMs,
} from "./manager.turn-timeout.js";
import type {
  AcpRunTurnInput,
  ActiveTurnState,
  AcpSessionManagerDeps,
  EnsureManagerRuntimeHandle,
  ReconcileManagerRuntimeSessionIdentifiers,
  ResolveManagerSessionAsync,
  SessionAcpMeta,
  SetManagerSessionState,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import {
  assertCurrentAcpActor,
  acpSessionActorKey,
  requireReadySessionMeta,
  resolveStoredAcpSession,
} from "./manager.utils.js";

const ACP_TURN_TIMEOUT_GRACE_MS = 1_000;

export async function runManagerTurn(params: {
  input: AcpRunTurnInput;
  sessionKey: string;
  agentId: string;
  runtimeHandles: ManagerRuntimeHandleCache;
  activeTurnBySession: Map<string, ActiveTurnState>;
  resolveSession: ResolveManagerSessionAsync;
  prepareSessionControlRead: AcpSessionManagerDeps["prepareSessionControlRead"];
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  setSessionState: SetManagerSessionState;
  recordTurnCompletion: (params: {
    startedAt: number;
    errorCode?: AcpRuntimeError["code"];
  }) => void;
  reconcileRuntimeSessionIdentifiers: ReconcileManagerRuntimeSessionIdentifiers;
  writeSessionMeta: WriteManagerSessionMeta;
  isCurrentActor: () => boolean;
  producer: SessionControllerProducer;
  ownsTurnTerminal: boolean;
}): Promise<void> {
  const { input, sessionKey, agentId } = params;
  const cancellationCleanupFailed = (error: unknown): never => {
    if (signal.aborted) {
      params.producer.recordCancellationFailure(error);
    }
    throw error;
  };
  const operatorAuthority = readAdmittedRunOperatorAuthority(input.admittedRunContext);
  const manifestPlugins = getProcessGatewayPluginMetadataSnapshot() ?? [];
  const resolveModelRef = (model: string | undefined) => {
    const ref = model ? parseModelCatalogRef(model) : undefined;
    return ref
      ? normalizeModelRef(ref.provider, ref.modelId, {
          allowPluginNormalization: false,
          manifestPlugins,
        })
      : undefined;
  };
  const assertModelAllowed = (model: string | undefined) =>
    assertOperatorModelAllowed(operatorAuthority, resolveModelRef(model));
  if (input.admittedRunContext.operationalRunInstance.runId !== input.requestId) {
    throw new Error("ACP operational run instance disagrees with the admitted request");
  }
  const turnStartedAt = Date.now();
  const actorKey = acpSessionActorKey(params);
  // Model revocation and handle discard abort this turn beside its caller's signal.
  const abortController = new AbortController();
  let signal = input.signal
    ? AbortSignal.any([input.signal, abortController.signal])
    : abortController.signal;
  let assertSignalAdmission = resolveAdmittedRunActiveAssertion(input.admittedRunContext, signal);
  const assertActorCurrent = () => {
    assertCurrentAcpActor(params.isCurrentActor(), sessionKey);
  };
  const assertSignalCurrent = () => {
    assertActorCurrent();
    signal.throwIfAborted();
    assertSignalAdmission?.();
  };
  assertSignalCurrent();
  // Metadata reads and signal preparation also hold restart-drain custody.
  // Each release is fenced so a retired actor cannot erase its successor.
  let releaseActiveTurn = markAcpTurnActive(params);
  let spawnedByWatcher: string | undefined;
  let control: Awaited<ReturnType<AcpSessionManagerDeps["prepareSessionControlRead"]>> | undefined;
  let cancellationControl: Parameters<SetManagerSessionState>[0]["acpControl"];
  let runtimeLocator: AcpSessionRuntimeLocator | undefined;
  const assertCancellationCurrent = () => {
    assertActorCurrent();
    control?.assertCurrent(input.cfg);
    control?.assertAcpCurrent?.(input.cfg, runtimeLocator);
  };
  const revalidateCancellation = async () => {
    try {
      const current = await control?.readCurrent(input.cfg);
      assertCancellationCurrent();
      if (
        runtimeLocator &&
        !matchesAcpSessionRuntimeLocator(current?.session.acp, runtimeLocator)
      ) {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          "ACP runtime locator changed before cancellation.",
        );
      }
      cancellationControl = current?.constraint
        ? { ...current.constraint, ...(runtimeLocator ? { runtimeLocator } : {}) }
        : undefined;
      return cancellationControl;
    } catch (error) {
      params.producer.recordCancellationFailure(error);
      const cachedHandle = params.runtimeHandles.get(params)?.handle;
      if (cachedHandle && params.isCurrentActor() && cachedHandle === runtimeLocator) {
        params.runtimeHandles.clearIfHandleMatches({ ...params, handle: cachedHandle });
      }
      throw error;
    }
  };
  const recordTerminalState = async (
    outcomeStatus: Parameters<typeof recordSubagentTerminalState>[0]["outcomeStatus"],
    cancelling: boolean,
  ) => {
    if (cancelling) {
      await revalidateCancellation();
    }
    if (spawnedByWatcher) {
      await recordSubagentTerminalState(
        {
          childSessionKey: sessionKey,
          agentId,
          runId: input.requestId,
          requesterSessionKey: spawnedByWatcher,
          outcomeStatus,
        },
        cancelling ? assertCancellationCurrent : assertActorCurrent,
        cancelling ? cancellationControl : undefined,
      ).catch(cancellationCleanupFailed);
    }
  };

  try {
    let initialResolution: Awaited<ReturnType<ResolveManagerSessionAsync>>;
    let initialMeta: SessionAcpMeta;
    try {
      control = await params.prepareSessionControlRead({
        cfg: input.cfg,
        sessionKey,
        agentId,
        assertCurrent: assertActorCurrent,
      });
      initialResolution = resolveStoredAcpSession(
        { sessionKey, agentId },
        control.initialRead.session,
      );
      assertSignalCurrent();
      initialMeta = requireReadySessionMeta(initialResolution);
      // ACP children bypass the subagent registry; retain their requester for
      // terminal signals and admission once the native metadata read completes.
      spawnedByWatcher =
        initialResolution.kind === "ready"
          ? (initialResolution.entry?.spawnedBy ?? initialResolution.entry?.parentSessionKey)
          : undefined;
      if (spawnedByWatcher) {
        releaseActiveTurn = markAcpTurnActive({ ...params, ownerSessionKey: spawnedByWatcher });
      }
      await recordSessionHumanDirectMessage(
        {
          sessionKey,
          agentId,
          entry: initialResolution.kind === "ready" ? initialResolution.entry : undefined,
          actor: { actorType: input.provenance },
          channel: "acp",
          runId: input.requestId,
        },
        { assertCurrent: assertSignalCurrent },
      );
      assertSignalCurrent();
    } catch (error) {
      const cancelled = signal.aborted;
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: cancelled ? "ACP_TURN_FAILED" : "ACP_SESSION_INIT_FAILED",
        fallbackMessage: cancelled
          ? "ACP operation aborted."
          : "Could not prepare ACP session runtime.",
      });
      params.recordTurnCompletion({
        startedAt: turnStartedAt,
        ...(cancelled ? {} : { errorCode: acpError.code }),
      });
      if (spawnedByWatcher && params.isCurrentActor()) {
        await recordTerminalState(
          cancelled
            ? "cancelled"
            : acpError.detailCode === ACP_TURN_TIMEOUT_DETAIL_CODE
              ? "timeout"
              : "error",
          cancelled,
        );
      }
      throw acpError;
    }
    const { storePath } = resolveSessionStorePathForAcp({ cfg: input.cfg, sessionKey, agentId });
    return await withSessionTurn(
      {
        sessionKey,
        agentId,
        storePath,
        sessionId:
          initialResolution.kind === "ready" ? initialResolution.entry?.sessionId : undefined,
        abortSignal: signal,
      },
      async (operation, executionSignal) => {
        signal = executionSignal;
        assertSignalAdmission = resolveAdmittedRunActiveAssertion(input.admittedRunContext, signal);
        const { candidateBackends, describeBackendCandidate } = resolveBackendCandidatePlan({
          configuredPrimaryBackend: input.cfg.acp?.backend,
          resolvedPrimaryBackend: initialMeta.backend,
          fallbackBackends: input.cfg.acp?.fallbacks,
        });
        const backendAttempts: BackendAttempt[] = [];
        const recordBackendFailure = async (error: AcpRuntimeError) => {
          assertActorCurrent();
          const failedBackends = backendAttempts
            .map((attempt) => `${attempt.backend}: ${attempt.error}`)
            .join(" | ");
          const errorToRecord =
            backendAttempts.length > 1
              ? new AcpRuntimeError(
                  error.code,
                  `All ACP backends failed (${backendAttempts.length}): ${failedBackends}`,
                  { detailCode: error.detailCode },
                )
              : error;
          params.recordTurnCompletion({
            startedAt: turnStartedAt,
            errorCode: errorToRecord.code,
          });
          const cancelling = signal.aborted;
          if (cancelling || spawnedByWatcher) {
            await recordTerminalState(
              errorToRecord.detailCode === ACP_TURN_TIMEOUT_DETAIL_CODE ? "timeout" : "error",
              cancelling,
            );
          }
          if (spawnedByWatcher) {
            assertActorCurrent();
          }
          await params
            .setSessionState({
              cfg: input.cfg,
              sessionKey,
              agentId,
              isCurrentActor: params.isCurrentActor,
              state: "error",
              lastError: formatAcpErrorChain(errorToRecord),
              ...(cancelling
                ? { assertCurrent: assertCancellationCurrent, acpControl: cancellationControl }
                : {}),
            })
            .catch(cancellationCleanupFailed);
          throw errorToRecord;
        };

        for (const [backendIdx, currentBackend] of candidateBackends.entries()) {
          if (backendIdx > 0) {
            await params.runtimeHandles.close({
              sessionKey,
              agentId,
              reason: "backend-failover",
            });
            logVerbose(
              `acp-manager: switching backend for ${sessionKey} from ${describeBackendCandidate(
                expectDefined(
                  candidateBackends[backendIdx - 1],
                  "candidate backends entry at backend idx 1",
                ),
              )} to ${describeBackendCandidate(currentBackend)}`,
            );
          }

          for (let attempt = 0; attempt < 2; attempt += 1) {
            const resolution =
              backendIdx === 0 && attempt === 0
                ? initialResolution
                : await params.resolveSession({
                    cfg: input.cfg,
                    sessionKey,
                    agentId,
                    assertCurrent: assertSignalCurrent,
                  });
            assertSignalCurrent();
            const resolvedMeta = requireReadySessionMeta(resolution);
            assertModelAllowed(resolvedMeta.runtimeOptions?.model);
            let runtime: AcpRuntime | undefined;
            let handle: AcpRuntimeHandle | undefined;
            let meta: SessionAcpMeta | undefined;
            let activeTurn: ActiveTurnState | undefined;
            let activeTurnStarted = false;
            let promptStarted = false;
            let turnTerminal = false;
            let sawTurnOutput = false;
            let retryFreshHandle = false;
            let skipPostTurnCleanup = false;
            let modelExecution: ReturnType<typeof bindOperatorModelExecution>;
            const onModelRevoked = () => abortController.abort(modelExecution?.signal.reason);
            let onTurnAborted: (() => void) | undefined;
            try {
              // Failed setup still belongs to the runtime selected before ensure yielded.
              runtimeLocator = {
                backend: resolvedMeta.backend,
                runtimeSessionName: resolvedMeta.runtimeSessionName,
              };
              const ensured = await params.ensureRuntimeHandle({
                readAcpControl: () =>
                  signal.aborted
                    ? (cancellationControl ?? control?.initialRead.constraint)
                    : undefined,
                assertMetadataCommitAllowed: (locator) => {
                  if (signal.aborted) {
                    assertCancellationCurrent();
                    control?.assertAcpCurrent?.(input.cfg, locator);
                  }
                },
                cfg: input.cfg,
                sessionKey,
                agentId,
                meta: resolvedMeta,
                selectedBackend: currentBackend,
                isCurrentActor: params.isCurrentActor,
              });
              assertActorCurrent();
              runtime = ensured.runtime;
              handle = ensured.handle;
              runtimeLocator = handle;
              meta = ensured.meta;
              let appliedModel = handle.appliedModel
                ? handle.appliedModel.kind === "applied"
                  ? handle.appliedModel.model
                  : undefined
                : meta.runtimeOptions?.model;
              assertModelAllowed(appliedModel);
              activeTurn = { runtime, handle, abortController };
              // Publish custody before controls or state persistence can yield, so a
              // forced discard reaches this exact late handle.
              params.activeTurnBySession.set(actorKey, activeTurn);
              if (!signal.aborted) {
                await applyManagerRuntimeControls({
                  sessionKey,
                  runtime,
                  handle,
                  meta,
                  isCurrentActor: params.isCurrentActor,
                  getCachedRuntimeState: () => params.runtimeHandles.get(params),
                  onModelApplied: (model) => {
                    appliedModel = model;
                    assertModelAllowed(appliedModel);
                  },
                  onOptionsChanged: async (runtimeOptions) => {
                    await params.writeSessionMeta({
                      cfg: input.cfg,
                      sessionKey,
                      agentId,
                      isCurrentActor: params.isCurrentActor,
                      mutate: (current) => (current ? { ...current, runtimeOptions } : null),
                      failOnError: true,
                    });
                    meta = { ...ensured.meta, runtimeOptions };
                  },
                });
              }

              modelExecution = bindOperatorModelExecution(
                operatorAuthority,
                resolveModelRef(appliedModel),
              );
              modelExecution?.signal.addEventListener("abort", onModelRevoked, { once: true });
              modelExecution?.assertCurrent();

              if (!signal.aborted) {
                await params.setSessionState({
                  cfg: input.cfg,
                  sessionKey,
                  agentId,
                  isCurrentActor: params.isCurrentActor,
                  state: "running",
                  clearLastError: true,
                });
              }

              assertActorCurrent();
              activeTurnStarted = true;
              const turnToCancel = activeTurn;
              const cancelTurn = () =>
                cancelManagerActiveTurn({
                  activeTurn: turnToCancel,
                  reason: typeof signal.reason === "string" ? signal.reason : undefined,
                  revalidate: async () => {
                    await revalidateCancellation();
                    await params.producer.revalidateCancellation();
                  },
                  assertCurrent: () => {
                    assertCancellationCurrent();
                    params.producer.assertCancellationAllowed();
                  },
                }).catch(cancellationCleanupFailed);
              // A caller Stop after submission reaches the backend here; before it, the stream cancels.
              // Internal aborts (timeout, model revocation, discard) own their backend cleanup.
              onTurnAborted = () => {
                if (turnTerminal) {
                  return;
                }
                cancelTurn().catch((error: unknown) => {
                  logVerbose(
                    `acp-manager: runtime cancel failed for ${sessionKey}: ${String(error)}`,
                  );
                });
              };
              signal.addEventListener("abort", onTurnAborted, { once: true });
              const eventGate = { open: true };
              const turnPromise = consumeAcpTurnStream({
                runtime,
                source: composeSessionSourceAssertion([assertSignalAdmission], (assertSource) => {
                  assertActorCurrent();
                  signal.throwIfAborted();
                  modelExecution?.assertCurrent();
                  assertSource();
                }),
                turn: {
                  handle,
                  text: input.text,
                  attachments: input.attachments,
                  mode: input.mode,
                  requestId: input.requestId,
                  signal,
                  onElicitation: input.onElicitation,
                },
                eventGate,
                onBeforePrompt: async () => {
                  await input.onBeforePrompt?.();
                  modelExecution?.assertCurrent();
                },
                onCancellation: cancelTurn,
                onPromptStarted: async ({ authoritative }) => {
                  if (!params.isCurrentActor()) {
                    return;
                  }
                  promptStarted = authoritative;
                  if (authoritative) {
                    const assertAdmitted = resolveAdmittedRunActiveAssertion(
                      input.admittedRunContext,
                    );
                    if (!assertAdmitted) {
                      throw new Error("ACP execution authority closed before prompt submission");
                    }
                    assertAdmitted();
                  }
                  try {
                    await input.onLifecycle?.({
                      type: "prompt_submitted",
                      at: Date.now(),
                    });
                  } catch (error) {
                    logVerbose(
                      `acp-manager: prompt submission observer failed for ${sessionKey}: ${String(error)}`,
                    );
                  }
                },
                onOutputEvent: () => {
                  modelExecution?.signal.throwIfAborted();
                  if (!params.isCurrentActor()) {
                    return;
                  }
                  sawTurnOutput = true;
                },
                onEvent: async (event) => {
                  if (event.type === "done") {
                    turnTerminal = true;
                    if (params.ownsTurnTerminal) {
                      operation?.freezeAbort();
                    }
                  }
                  modelExecution?.signal.throwIfAborted();
                  if (params.isCurrentActor()) {
                    try {
                      await input.onEvent?.(event);
                    } catch (error) {
                      cancellationCleanupFailed(error);
                    }
                  }
                },
              });
              const turnTimeoutMs = resolveTurnTimeoutMs({
                cfg: input.cfg,
                meta,
              });
              const sessionMode = meta.mode;
              const turnOutcome = await awaitTurnWithTimeout({
                sessionKey,
                turnPromise,
                timeoutMs: turnTimeoutMs + ACP_TURN_TIMEOUT_GRACE_MS,
                timeoutLabelMs: turnTimeoutMs,
                onTimeout: async () => {
                  eventGate.open = false;
                  skipPostTurnCleanup = true;
                  if (!activeTurn) {
                    return;
                  }
                  await cleanupTimedOutTurn({
                    sessionKey,
                    activeTurn,
                    mode: sessionMode,
                    clearCachedRuntimeStateIfHandleMatches: (turn) => {
                      if (!params.isCurrentActor()) {
                        return;
                      }
                      params.runtimeHandles.clearIfHandleMatches({
                        sessionKey,
                        agentId,
                        handle: turn.handle,
                      });
                    },
                  });
                },
              });
              assertActorCurrent();
              modelExecution?.assertCurrent();
              if (!turnOutcome.terminalStatus) {
                throw new AcpRuntimeError(
                  "ACP_TURN_FAILED",
                  "ACP turn ended without a terminal done event.",
                );
              }
              params.recordTurnCompletion({
                startedAt: turnStartedAt,
              });
              turnTerminal = true;
              if (params.ownsTurnTerminal) {
                operation?.freezeAbort();
              }
              const cancelled = turnOutcome.terminalStatus === "cancelled";
              const cancelling = cancelled || signal.aborted;
              if (cancelling || spawnedByWatcher) {
                await recordTerminalState(cancelled ? "cancelled" : "ok", cancelling);
              }
              if (spawnedByWatcher) {
                assertActorCurrent();
              }
              await params
                .setSessionState({
                  cfg: input.cfg,
                  sessionKey,
                  agentId,
                  isCurrentActor: params.isCurrentActor,
                  state: "idle",
                  clearLastError: true,
                  ...(cancelling
                    ? { assertCurrent: assertCancellationCurrent, acpControl: cancellationControl }
                    : {}),
                })
                .catch(cancellationCleanupFailed);
              return;
            } catch (error) {
              const acpError = toAcpRuntimeError({
                error,
                fallbackCode: activeTurnStarted ? "ACP_TURN_FAILED" : "ACP_SESSION_INIT_FAILED",
                fallbackMessage: activeTurnStarted
                  ? "ACP turn failed before completion."
                  : "Could not initialize ACP session runtime.",
              });
              assertActorCurrent();
              retryFreshHandle = await prepareFreshManagerRuntimeHandleRetry({
                attempt,
                cfg: input.cfg,
                sessionKey,
                agentId,
                error: acpError,
                promptStarted,
                sawTurnOutput,
                runtime,
                meta,
                runtimeHandles: params.runtimeHandles,
                writeSessionMeta: params.writeSessionMeta,
                isCurrentActor: params.isCurrentActor,
              });
              assertActorCurrent();
              if (retryFreshHandle) {
                continue;
              }

              const backendAttempt = {
                backend: describeBackendCandidate(currentBackend),
                error: acpError.message,
                code: acpError.code,
                promptStarted,
                sawOutput: sawTurnOutput,
              };
              backendAttempts.push(backendAttempt);
              if (
                isAcpOwnerRepairRequired(acpError) ||
                !isFailoverWorthyBackendError(backendAttempt) ||
                backendIdx >= candidateBackends.length - 1
              ) {
                await recordBackendFailure(acpError);
              }
              break;
            } finally {
              if (onTurnAborted) {
                signal.removeEventListener("abort", onTurnAborted);
              }
              // A producer terminal does not release actor custody while cancellation is still active.
              try {
                await activeTurn?.cancelPromise;
              } finally {
                modelExecution?.signal.removeEventListener("abort", onModelRevoked);
                modelExecution?.release();
                if (activeTurn && params.activeTurnBySession.get(actorKey) === activeTurn) {
                  params.activeTurnBySession.delete(actorKey);
                }
                if (
                  !retryFreshHandle &&
                  !skipPostTurnCleanup &&
                  runtime &&
                  handle &&
                  meta &&
                  params.isCurrentActor()
                ) {
                  ({ handle, meta } = await params
                    .reconcileRuntimeSessionIdentifiers({
                      cfg: input.cfg,
                      sessionKey,
                      agentId,
                      runtime,
                      handle,
                      meta,
                      failOnStatusError: false,
                      isCurrentActor: params.isCurrentActor,
                      ...(signal.aborted
                        ? {
                            revalidateControl: revalidateCancellation,
                            assertCurrent: assertCancellationCurrent,
                          }
                        : {}),
                    })
                    .catch(cancellationCleanupFailed));
                }
                if (
                  !retryFreshHandle &&
                  !skipPostTurnCleanup &&
                  runtime &&
                  handle &&
                  meta &&
                  params.isCurrentActor() &&
                  meta.mode === "oneshot"
                ) {
                  try {
                    await runtime.close({
                      handle,
                      reason: "oneshot-complete",
                    });
                  } catch (error) {
                    logVerbose(
                      `acp-manager: ACP oneshot close failed for ${sessionKey}: ${String(error)}`,
                    );
                  } finally {
                    if (params.isCurrentActor()) {
                      params.runtimeHandles.clearIfHandleMatches({ ...params, handle });
                    }
                  }
                }
              }
            }
          }
        }
      },
    );
  } finally {
    control?.release();
    releaseActiveTurn?.();
  }
}
