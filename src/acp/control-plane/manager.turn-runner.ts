/** Runs ACP turns, failover, timeout cleanup, and detached-task progress mirroring. */
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
import { logVerbose } from "../../globals.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { recordSessionHumanDirectMessage } from "../../sessions/session-state-events.js";
import { recordSubagentTerminalState } from "../../sessions/subagent-terminal-state.js";
import { AcpRuntimeError, formatAcpErrorChain, toAcpRuntimeError } from "../runtime/errors.js";
import { markAcpTurnActive } from "./active-turns.js";
import type { AcceptedTurnState } from "./manager.accepted-turns.js";
import {
  isFailoverWorthyBackendError,
  resolveBackendCandidatePlan,
  shouldAttemptBackendFailover,
  type BackendAttempt,
} from "./manager.backend-failover.js";
import {
  appendBackgroundTaskProgressSummary,
  bindBackgroundTaskExecution,
  createBackgroundTaskRecord,
  markBackgroundTaskRunning,
  markBackgroundTaskTerminal,
  resolveBackgroundTaskContext,
  resolveBackgroundTaskFailureStatus,
  resolveBackgroundTaskTerminalResult,
} from "./manager.background-task.js";
import { cancelManagerActiveTurn } from "./manager.cancel-session.js";
import { applyManagerRuntimeControls } from "./manager.runtime-controls.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { createSupersededActorError } from "./manager.runtime-handle-ensure.js";
import { isAcpOwnerRepairRequired } from "./manager.runtime-owner.js";
import { prepareFreshManagerRuntimeHandleRetry } from "./manager.runtime-resume-state.js";
import { consumeAcpTurnStream } from "./manager.turn-stream.js";
import {
  awaitTurnWithTimeout,
  cleanupTimedOutTurn,
  resolveTurnTimeoutMs,
} from "./manager.turn-timeout.js";
import type {
  AcpRunTurnInput,
  AcpSessionManagerDeps,
  ActiveTurnState,
  EnsureManagerRuntimeHandle,
  ReconcileManagerRuntimeSessionIdentifiers,
  ResolveManagerSession,
  SetManagerSessionState,
  SessionAcpMeta,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import { acpSessionActorKey, requireReadySessionMeta } from "./manager.utils.js";

const ACP_TURN_TIMEOUT_GRACE_MS = 1_000;
const ACP_COMPLETION_EVIDENCE_MAX_BYTES = 100 * 1024;

/** Executes one ACP prompt turn against the selected backend and records terminal state. */
export async function runManagerTurn(params: {
  input: AcpRunTurnInput;
  acceptedTurn: AcceptedTurnState;
  sessionKey: string;
  agentId: string;
  deps: AcpSessionManagerDeps;
  runtimeHandles: ManagerRuntimeHandleCache;
  activeTurnBySession: Map<string, ActiveTurnState>;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  setSessionState: SetManagerSessionState;
  recordTurnCompletion: (params: {
    startedAt: number;
    errorCode?: AcpRuntimeError["code"];
  }) => void;
  reconcileRuntimeSessionIdentifiers: ReconcileManagerRuntimeSessionIdentifiers;
  writeSessionMeta: WriteManagerSessionMeta;
  isCurrentActor: () => boolean;
}): Promise<void> {
  const { input, sessionKey, agentId } = params;
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
  const taskContext =
    input.mode === "prompt"
      ? resolveBackgroundTaskContext({
          deps: params.deps,
          cfg: input.cfg,
          sessionKey,
          agentId,
          requestId: input.requestId,
          text: input.text,
        })
      : null;
  const taskRecord = taskContext
    ? createBackgroundTaskRecord(
        taskContext,
        turnStartedAt,
        input.admittedRunContext.operationalRunInstance.instanceId,
      )
    : undefined;
  let taskExecutionBinding: Promise<void> | undefined;
  let taskProgressSummary = "";
  const initialResolution = params.resolveSession({
    cfg: input.cfg,
    sessionKey,
    agentId,
  });
  const initialMeta = requireReadySessionMeta(initialResolution);
  const assertSignalAdmission = resolveAdmittedRunActiveAssertion(
    input.admittedRunContext,
    input.signal,
  );
  const assertActorCurrent = () => {
    if (!params.isCurrentActor()) {
      throw createSupersededActorError(sessionKey);
    }
  };
  const assertSignalCurrent = () => {
    assertActorCurrent();
    input.signal?.throwIfAborted();
    assertSignalAdmission?.();
  };
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
  // ACP children bypass the subagent registry; terminal outcomes are projected into
  // the signal log here so changesSince histories are not spawn-only for ACP runs.
  const spawnedByWatcher =
    initialResolution.kind === "ready"
      ? (initialResolution.entry?.spawnedBy ?? initialResolution.entry?.parentSessionKey)
      : undefined;
  const { candidateBackends, describeBackendCandidate } = resolveBackendCandidatePlan({
    configuredPrimaryBackend: input.cfg.acp?.backend,
    resolvedPrimaryBackend: initialMeta.backend,
    fallbackBackends: input.cfg.acp?.fallbacks,
  });
  const backendAttempts: BackendAttempt[] = [];
  const recordBackendFailure = async (error: AcpRuntimeError) => {
    await taskExecutionBinding;
    if (!params.isCurrentActor()) {
      throw createSupersededActorError(sessionKey);
    }
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
    if (taskContext) {
      const failureStatus = resolveBackgroundTaskFailureStatus(errorToRecord);
      if (taskRecord) {
        markBackgroundTaskTerminal(taskRecord, {
          status: failureStatus,
          endedAt: Date.now(),
          lastEventAt: Date.now(),
          error: formatAcpErrorChain(errorToRecord),
          progressSummary: taskProgressSummary || null,
          terminalSummary: failureStatus === "timed_out" ? taskProgressSummary || null : null,
        });
      }
      if (spawnedByWatcher) {
        await recordSubagentTerminalState(
          {
            childSessionKey: sessionKey,
            runId: taskContext.runId,
            requesterSessionKey: spawnedByWatcher,
            outcomeStatus: failureStatus === "timed_out" ? "timeout" : "error",
          },
          assertActorCurrent,
        );
        assertActorCurrent();
      }
    }
    await params.setSessionState({
      cfg: input.cfg,
      sessionKey,
      agentId,
      isCurrentActor: params.isCurrentActor,
      state: "error",
      lastError: formatAcpErrorChain(errorToRecord),
    });
    throw errorToRecord;
  };

  // Liveness spans the whole task, not one backend attempt. The release belongs to
  // this turn so a retired actor cannot erase a successor after reset overlap.
  const releaseActiveTurn = taskContext ? markAcpTurnActive(params) : undefined;

  try {
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
            : params.resolveSession({
                cfg: input.cfg,
                sessionKey,
                agentId,
              });
        const resolvedMeta = requireReadySessionMeta(resolution);
        assertModelAllowed(resolvedMeta.runtimeOptions?.model);
        let runtime: AcpRuntime | undefined;
        let handle: AcpRuntimeHandle | undefined;
        let meta: SessionAcpMeta | undefined;
        let activeTurn: ActiveTurnState | undefined;
        let activeTurnStarted = false;
        let promptStarted = false;
        let sawTurnOutput = false;
        let retryFreshHandle = false;
        let skipPostTurnCleanup = false;
        let completionEvidenceText = "";
        let completionEvidenceBytes = 0;
        let completionEvidenceOverflowed = false;
        let modelExecution: ReturnType<typeof bindOperatorModelExecution>;
        const onModelRevoked = () =>
          params.acceptedTurn.abortController.abort(modelExecution?.signal.reason);
        try {
          const ensured = await params.ensureRuntimeHandle({
            cfg: input.cfg,
            sessionKey,
            agentId,
            meta: resolvedMeta,
            selectedBackend: currentBackend,
            isCurrentActor: params.isCurrentActor,
          });
          if (!params.isCurrentActor()) {
            throw createSupersededActorError(sessionKey);
          }
          runtime = ensured.runtime;
          handle = ensured.handle;
          meta = ensured.meta;
          let appliedModel = handle.appliedModel
            ? handle.appliedModel.kind === "applied"
              ? handle.appliedModel.model
              : undefined
            : meta.runtimeOptions?.model;
          assertModelAllowed(appliedModel);
          activeTurn = {
            requestId: input.requestId,
            instanceId: input.admittedRunContext.operationalRunInstance.instanceId,
            runtime,
            handle,
            abortController: params.acceptedTurn.abortController,
          };
          // Publish custody before controls or state persistence can yield. A setup
          // cancellation must cancel this exact late handle before reporting done.
          params.acceptedTurn.activeTurn = activeTurn;
          params.activeTurnBySession.set(actorKey, activeTurn);
          if (!input.signal?.aborted) {
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

          if (!input.signal?.aborted) {
            await params.setSessionState({
              cfg: input.cfg,
              sessionKey,
              agentId,
              isCurrentActor: params.isCurrentActor,
              state: "running",
              clearLastError: true,
            });
          }

          if (!params.isCurrentActor()) {
            throw createSupersededActorError(sessionKey);
          }
          activeTurnStarted = true;
          const turnToCancel = activeTurn;
          const eventGate = { open: true };
          const turnPromise = consumeAcpTurnStream({
            runtime,
            turn: {
              handle,
              text: input.text,
              attachments: input.attachments,
              mode: input.mode,
              requestId: input.requestId,
              signal: input.signal,
              onElicitation: input.onElicitation,
            },
            eventGate,
            onBeforePrompt: async () => {
              await input.onBeforePrompt?.();
              modelExecution?.assertCurrent();
            },
            onCancellation: () =>
              cancelManagerActiveTurn({
                activeTurn: turnToCancel,
                reason: params.acceptedTurn.cancelReason,
                revalidate: params.acceptedTurn.revalidateCancel,
              }),
            onPromptStarted: async ({ authoritative }) => {
              if (!params.isCurrentActor()) {
                return;
              }
              promptStarted = authoritative;
              if (authoritative && taskRecord) {
                const assertAdmitted = resolveAdmittedRunActiveAssertion(input.admittedRunContext);
                taskExecutionBinding ??= bindBackgroundTaskExecution(
                  taskRecord,
                  input.admittedRunContext,
                  () => {
                    if (!params.isCurrentActor()) {
                      throw createSupersededActorError(sessionKey);
                    }
                    if (!assertAdmitted) {
                      throw new Error("ACP execution authority closed before owner binding");
                    }
                    assertAdmitted();
                  },
                );
                await taskExecutionBinding;
                if (!params.isCurrentActor()) {
                  return;
                }
                if (!assertAdmitted) {
                  throw new Error("ACP execution authority closed before owner binding");
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
            onOutputEvent: (event) => {
              modelExecution?.signal.throwIfAborted();
              if (!params.isCurrentActor()) {
                return;
              }
              sawTurnOutput = true;
              if (event.type === "text_delta" && event.stream !== "thought" && event.text) {
                taskProgressSummary = appendBackgroundTaskProgressSummary(
                  taskProgressSummary,
                  event.text,
                );
                // Keep semantic evidence attempt-local; only the bounded display summary is persisted.
                if (taskContext && !completionEvidenceOverflowed) {
                  completionEvidenceText += event.text;
                  completionEvidenceBytes = Buffer.byteLength(completionEvidenceText, "utf8");
                  if (completionEvidenceBytes > ACP_COMPLETION_EVIDENCE_MAX_BYTES) {
                    completionEvidenceOverflowed = true;
                    completionEvidenceText = "";
                  }
                }
              }
              if (taskRecord) {
                markBackgroundTaskRunning(taskRecord, {
                  lastEventAt: Date.now(),
                  progressSummary: taskProgressSummary || null,
                });
              }
            },
            onEvent: async (event) => {
              modelExecution?.signal.throwIfAborted();
              if (params.isCurrentActor()) {
                await input.onEvent?.(event);
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
          if (!params.isCurrentActor()) {
            throw createSupersededActorError(sessionKey);
          }
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
          if (taskContext) {
            const terminalResult =
              turnOutcome.terminalStatus === "cancelled"
                ? {}
                : completionEvidenceOverflowed
                  ? {
                      terminalOutcome: "blocked" as const,
                      terminalSummary:
                        "Required completion output exceeded the 100 KB verification limit; inspect the child session for the final deliverable.",
                    }
                  : resolveBackgroundTaskTerminalResult(completionEvidenceText);
            if (taskRecord) {
              markBackgroundTaskTerminal(taskRecord, {
                status: turnOutcome.terminalStatus === "cancelled" ? "cancelled" : "succeeded",
                endedAt: Date.now(),
                lastEventAt: Date.now(),
                error: undefined,
                progressSummary: taskProgressSummary || null,
                terminalSummary: terminalResult.terminalSummary ?? null,
                terminalOutcome: terminalResult.terminalOutcome,
              });
            }
            if (spawnedByWatcher) {
              await recordSubagentTerminalState(
                {
                  childSessionKey: sessionKey,
                  runId: taskContext.runId,
                  requesterSessionKey: spawnedByWatcher,
                  outcomeStatus: turnOutcome.terminalStatus === "cancelled" ? "cancelled" : "ok",
                },
                assertActorCurrent,
              );
              assertActorCurrent();
            }
          }
          await params.setSessionState({
            cfg: input.cfg,
            sessionKey,
            agentId,
            isCurrentActor: params.isCurrentActor,
            state: "idle",
            clearLastError: true,
          });
          return;
        } catch (error) {
          const acpError = toAcpRuntimeError({
            error,
            fallbackCode: activeTurnStarted ? "ACP_TURN_FAILED" : "ACP_SESSION_INIT_FAILED",
            fallbackMessage: activeTurnStarted
              ? "ACP turn failed before completion."
              : "Could not initialize ACP session runtime.",
          });
          if (!params.isCurrentActor()) {
            throw createSupersededActorError(sessionKey);
          }
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
          if (!params.isCurrentActor()) {
            throw createSupersededActorError(sessionKey);
          }
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
            !shouldAttemptBackendFailover({
              backendIndex: backendIdx,
              candidateBackends,
            })
          ) {
            await recordBackendFailure(acpError);
          }
          break;
        } finally {
          modelExecution?.signal.removeEventListener("abort", onModelRevoked);
          modelExecution?.release();
          if (params.acceptedTurn.activeTurn === activeTurn) {
            params.acceptedTurn.activeTurn = undefined;
          }
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
            ({ handle, meta } = await params.reconcileRuntimeSessionIdentifiers({
              cfg: input.cfg,
              sessionKey,
              agentId,
              runtime,
              handle,
              meta,
              failOnStatusError: false,
              isCurrentActor: params.isCurrentActor,
            }));
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
        if (retryFreshHandle) {
          continue;
        }
      }
    }
  } finally {
    try {
      await taskExecutionBinding;
    } finally {
      releaseActiveTurn?.();
    }
  }
}
