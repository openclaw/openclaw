import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { createAbortError } from "../../../infra/abort-signal.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
  withAgentRunLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../../../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  getAgentRunContext,
  retainQueuedAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { isBackgroundWorkLane } from "../../../process/background-work.js";
import {
  CommandLaneTaskTimeoutError,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  isCommandLaneTaskTimeoutError,
} from "../../../process/command-queue.js";
import type {
  CommandQueueAdmissionOptions,
  CommandQueueEnqueueOptions,
  CommandQueueTaskDeadline,
} from "../../../process/command-queue.types.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import {
  assertSessionControllerOperation,
  markReplyOperationExecutionStarted,
  readSessionControllerOperationState,
} from "../../../sessions/session-controller.state.js";
import {
  createSessionControllerWatchdog,
  type SessionControllerWatchdog,
  type SessionControllerWatchdogAttempt,
  type SessionWatchdogWait,
} from "../../../sessions/session-controller.watchdog.js";
import { createPendingPromiseTracker } from "../../../shared/pending-promises.js";
import { getAdmittedRunDelegatedAuthority } from "../../admitted-run-context.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import { beginForegroundSessionMaintenance } from "../../session-maintenance/coordinator.js";
import { withSessionPlacementTurnAdmission } from "../../session-placement-admission.js";
import {
  resolveSessionPlacementForcedTerminalSettlement,
  resolveSessionPlacementTurnSettlementAssertion,
} from "../../session-placement-forced-terminal-settlement.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { withReleasableExecutionCapacity } from "./execution-capacity.js";
import {
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
  resolveEmbeddedRunLaneTimeoutMs,
  resolveEmbeddedRunSessionLanePolicy,
  shouldNoteLaneWait,
} from "./lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

type LaneParams = RunEmbeddedAgentParams & { sessionFile: string };

export function createEmbeddedRunLaneController<TParams extends LaneParams>(options: {
  getLifecycleGeneration: () => string;
  getParams: () => TParams;
  globalLane: string;
  initialQueuedLifecycleGeneration: string;
  setLifecycleGeneration: (generation: string) => void;
  setParams: (params: TParams) => void;
  onSessionWriterClaimed?: (entry: InternalSessionEntry) => void;
}) {
  const initialParams = options.getParams();
  const taskIdentity: CommandQueueEnqueueOptions["taskIdentity"] = {
    taskKind:
      initialParams.trigger === "cron" ? "cron" : initialParams.spawnedBy ? "spawn" : "turn",
    sessionKey: initialParams.sessionKey,
    runId: initialParams.runId,
    requesterSessionKey: initialParams.spawnedBy ?? undefined,
    modelFallbackCandidate: initialParams.isFinalFallbackAttempt !== undefined,
  };
  const sessionLanePolicy = resolveEmbeddedRunSessionLanePolicy(
    initialParams.trigger,
    initialParams.inputProvenance,
  );
  const laneTaskTimeoutMs = resolveEmbeddedRunLaneTimeoutMs(initialParams.timeoutMs);
  const laneTaskAbortController = new AbortController();
  // Queue cancellation remains authoritative before execution and during a
  // later isolated finalizer, after the original attempt's listeners close.
  const abortSignal = AbortSignal.any([
    ...(initialParams.abortSignal ? [initialParams.abortSignal] : []),
    laneTaskAbortController.signal,
  ]);
  let laneTaskProgressAtMs = Date.now();
  let laneTaskStartedAtMs = laneTaskProgressAtMs;
  let laneTaskAbortedAtMs: number | undefined;
  let laneTaskTimeoutError: CommandLaneTaskTimeoutError | undefined;
  const createLaneTimeoutError = (cause: "owner-deadline" | "release-signal" | "abort-grace") =>
    new CommandLaneTaskTimeoutError(options.globalLane, {
      elapsedMs: Math.max(0, Date.now() - laneTaskStartedAtMs),
      taskBudgetMs: laneTaskTimeoutMs,
      ...(cause === "abort-grace"
        ? { cause, graceMs: EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS }
        : { cause }),
    });
  let laneTaskDeadline: CommandQueueTaskDeadline | undefined;
  const boundedLaneDeadline = () =>
    laneTaskDeadline?.kind === "bounded" ? laneTaskDeadline.deadlineAtMs : undefined;
  const setLaneTaskDeadline = (deadline: CommandQueueTaskDeadline | undefined) => {
    laneTaskDeadline =
      deadline?.kind === "bounded"
        ? {
            kind: "bounded",
            deadlineAtMs: deadline.deadlineAtMs + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
          }
        : deadline;
    activeWatchdogAttempt?.setExecutionDeadline(boundedLaneDeadline());
  };
  let executionWatchdog: SessionControllerWatchdog | undefined;
  let activeWatchdogAttempt: SessionControllerWatchdogAttempt | undefined;
  let ownedGlobalCapacityWaits = 0;
  let activeGlobalCapacityTickets = 0;
  const pendingGlobalExecutions = new Set<Promise<unknown>>();
  const trackGlobalExecution = createPendingPromiseTracker(pendingGlobalExecutions);
  let releaseQueuedRunContext: ReturnType<typeof retainQueuedAgentRunContext>;
  let queuedRunAbortSignal: AbortSignal | undefined;
  let releaseCapacityWait: (() => void) | undefined;
  const endCapacityWait = () => {
    releaseCapacityWait?.();
    releaseCapacityWait = undefined;
  };
  const noteCapacityWait = () => {
    const params = options.getParams();
    if (!params.abortSignal?.aborted) {
      releaseCapacityWait = registerAgentRunCapacityWait(
        params.runId,
        options.getLifecycleGeneration(),
      );
    }
  };

  const releaseQueuedContext = (outcome: "admitted" | "abandoned") => {
    endCapacityWait();
    queuedRunAbortSignal?.removeEventListener("abort", abandonQueuedContext);
    queuedRunAbortSignal = undefined;
    releaseQueuedRunContext?.(outcome);
    releaseQueuedRunContext = undefined;
  };
  const abandonQueuedContext = () => releaseQueuedContext("abandoned");

  const noteLaneTaskProgress = () => {
    laneTaskProgressAtMs = Date.now();
  };
  let assertPlacementCurrent: (() => void) | undefined;
  let activeAttemptOwner: object | undefined;
  let recoverAttemptDeadline: (() => Promise<boolean>) | undefined;
  const recoverExecutionDeadline = async () => {
    if (await recoverAttemptDeadline?.()) {
      return true;
    }
    if (!abortSignal.aborted) {
      laneTaskTimeoutError ??= createLaneTimeoutError("owner-deadline");
    }
    return false;
  };
  const createAttemptControls = (input: {
    admittedRunContext: NonNullable<RunEmbeddedAgentParams["admittedRunContext"]>;
    abortSignal?: AbortSignal;
    initialTimeoutMs?: number;
    onAbort?: () => void;
  }) => {
    // Awaited preflight may finish after recovery has released this lane's claim.
    assertPlacementCurrent?.();
    const owner = {};
    activeAttemptOwner = owner;
    const lifecycleGeneration = options.getLifecycleGeneration();
    const authority = getAdmittedRunDelegatedAuthority(input.admittedRunContext);
    const signal = input.abortSignal
      ? AbortSignal.any([abortSignal, input.abortSignal])
      : abortSignal;
    let state: "active" | "aborted" | "closed" = "active";
    let deadlineOwned = false;
    let timeoutCleanupRequested = false;
    const operation = options.getParams().replyOperation;
    const isAttemptCurrent = () =>
      state === "active" &&
      activeAttemptOwner === owner &&
      !signal.aborted &&
      isAgentEventLifecycleGenerationCurrent(lifecycleGeneration);
    const isCurrent = () =>
      isAttemptCurrent() &&
      authority !== undefined &&
      getAdmittedRunDelegatedAuthority(input.admittedRunContext) === authority &&
      // A source callback can synchronously retire this attempt without closing its run.
      isAttemptCurrent();
    recoverAttemptDeadline = async () => {
      if (!operation || !timeoutCleanupRequested || !isCurrent()) {
        return false;
      }
      // Native timeout already requested teardown. Retire admission only after
      // exact writer fencing; its raw producer keeps execution/global custody.
      const retired =
        await readSessionControllerOperationState(operation)?.retireAdmissionAfterFencing(
          isCurrent,
        );
      if (!isCurrent()) {
        return true;
      }
      if (retired) {
        laneTaskTimeoutError ??= createLaneTimeoutError("release-signal");
        laneTaskAbortController.abort(laneTaskTimeoutError);
      }
      return retired === true;
    };
    const onAttemptDeadlineChanged = (deadline: CommandQueueTaskDeadline) => {
      if (isCurrent()) {
        deadlineOwned = true;
        setLaneTaskDeadline(deadline);
      }
    };
    if (input.initialTimeoutMs !== undefined) {
      const deadline: CommandQueueTaskDeadline =
        input.initialTimeoutMs >= MAX_TIMER_TIMEOUT_MS
          ? { kind: "unlimited" }
          : { kind: "bounded", deadlineAtMs: Date.now() + input.initialTimeoutMs };
      onAttemptDeadlineChanged(deadline);
    }
    return {
      bindWatchdogAttempt: (attempt: SessionControllerWatchdogAttempt) => {
        if (!isCurrent()) {
          return;
        }
        activeWatchdogAttempt = attempt;
        attempt.setExecutionDeadline(boundedLaneDeadline());
      },
      isCurrent,
      isAttemptCurrent,
      abortSignal: signal,
      onAttemptDeadlineChanged,
      onAttemptTimeout: (_reason: Error) => {
        if (!isCurrent() || timeoutCleanupRequested) {
          return;
        }
        timeoutCleanupRequested = true;
        // Native timeout unwind uses the operation's timer; replacements close this deadline.
        deadlineOwned = true;
        setLaneTaskDeadline({ kind: "bounded", deadlineAtMs: Date.now() });
      },
      onAttemptAbort: () => {
        if (!isCurrent()) {
          return;
        }
        state = "aborted";
        laneTaskAbortController.abort(createAgentRunDirectAbortError());
        input.onAbort?.();
      },
      close: () => {
        if (state === "closed") {
          return;
        }
        // Every retry/finalizer gets a fresh closure; retained callbacks must
        // never change the next attempt's deadline or cancellation state.
        state = "closed";
        if (activeAttemptOwner === owner) {
          activeAttemptOwner = undefined;
          recoverAttemptDeadline = undefined;
          if (deadlineOwned) {
            setLaneTaskDeadline(undefined);
          }
          activeWatchdogAttempt = undefined;
          noteLaneTaskProgress();
        }
      },
    };
  };
  const resolveLaneTimeoutError = () => {
    // Preserve the published timeout classification without releasing raw custody early.
    if (
      laneTaskAbortedAtMs !== undefined &&
      Date.now() - laneTaskAbortedAtMs >= EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS
    ) {
      laneTaskTimeoutError ??= createLaneTimeoutError("abort-grace");
    }
    return laneTaskTimeoutError;
  };
  const throwIfAborted = () => {
    if (!abortSignal.aborted) {
      // Cancellation retains its original reason even after cleanup closes the claim.
      assertPlacementCurrent?.();
      return;
    }
    const reason = resolveLaneTimeoutError() ?? abortSignal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    throw createAbortError(
      "Operation aborted",
      reason === undefined ? undefined : { cause: reason },
    );
  };
  const assertCurrent = () => {
    throwIfAborted();
    assertAgentRunLifecycleGenerationCurrent(options.getLifecycleGeneration());
    options.getParams().preparedRunAdmission?.assertSourceCurrent();
  };

  const noteLaneWaitIfBusy = (lane: string) => {
    const params = options.getParams();
    if (!params.onLaneWait) {
      return;
    }
    const snapshot = getCommandLaneSnapshot(lane);
    if (shouldNoteLaneWait(snapshot)) {
      params.onLaneWait({
        waitMs: 0,
        queuedAhead: snapshot.queuedCount + snapshot.activeCount,
        waiting: true,
      });
    }
  };
  const enqueueGlobal = async (
    task: () => Promise<EmbeddedAgentRunResult>,
    opts?: CommandQueueEnqueueOptions,
  ) => {
    let capacityHeld = false;
    // Global-lane admission is healthy waiting, not run execution. Keep reply
    // staleness and stuck recovery fenced until this queue grants capacity.
    let waitingForGlobalLaneAdmission = true;
    const waitingWatchdog = options.getParams().replyOperation?.watchdog ?? executionWatchdog;
    let capacityWait: SessionWatchdogWait | undefined;
    let ownsCapacityWait = false;
    const beginCapacityWait = () => {
      if (ownsCapacityWait || !waitingForGlobalLaneAdmission || abortSignal.aborted) {
        return;
      }
      ownsCapacityWait = true;
      ownedGlobalCapacityWaits += 1;
      options.getParams().replyOperation?.markWaitingForGlobalLane();
      capacityWait = waitingWatchdog?.beginWait({
        kind: "global_capacity",
        isCurrent: () => waitingForGlobalLaneAdmission && !abortSignal.aborted,
      });
    };
    const finishGlobalLaneAdmission = () => {
      if (!waitingForGlobalLaneAdmission) {
        return;
      }
      waitingForGlobalLaneAdmission = false;
      capacityWait?.close();
      if (ownsCapacityWait) {
        ownsCapacityWait = false;
        ownedGlobalCapacityWaits -= 1;
      }
    };
    const taskWithCurrentLifecycle = async () => {
      endCapacityWait();
      beginCapacityWait();
      noteLaneTaskProgress();
      let params = options.getParams();
      throwIfAborted();
      let lifecycleGeneration = options.getLifecycleGeneration();
      const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
      const existingContext = getAgentRunContext(params.runId);
      if (lifecycleGeneration !== currentLifecycleGeneration) {
        const wasQueuedBeforeRotation =
          options.initialQueuedLifecycleGeneration === lifecycleGeneration;
        const newerSameIdExecutionOwnsContext =
          existingContext?.lifecycleGeneration === currentLifecycleGeneration;
        if (
          !wasQueuedBeforeRotation ||
          !sessionLanePolicy.canResumeAcrossRotation ||
          newerSameIdExecutionOwnsContext
        ) {
          assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        }
        lifecycleGeneration = currentLifecycleGeneration;
        options.setLifecycleGeneration(lifecycleGeneration);
        params = { ...params, lifecycleGeneration };
        options.setParams(params);
      }
      // Queue waits can outlive durable harness and placement bindings.
      // Recheck and claim only after lifecycle admission, before context or hooks execute.
      const writerClaim = await claimAgentSessionWriter(params);
      if (writerClaim) {
        params = {
          ...params,
          sessionTarget: {
            ...params.sessionTarget,
            expectedLifecycleRevision: writerClaim.expectedLifecycleRevision,
            expectedWriterRunId: writerClaim.expectedWriterRunId,
          },
        };
        options.setParams(params);
        options.onSessionWriterClaimed?.(writerClaim.entry);
      }
      const laneExecution = withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
        withSessionPlacementTurnAdmission(
          {
            sessionId: params.sessionId,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            runId: params.runId,
          },
          params,
          (signal) => {
            params = { ...params, abortSignal: signal };
            options.setParams(params);
            assertPlacementCurrent = resolveSessionPlacementTurnSettlementAssertion();
            const operation = options.getParams().replyOperation;
            if (operation) {
              assertSessionControllerOperation(operation);
              markReplyOperationExecutionStarted(operation);
              if (operation.phase === "queued") {
                operation.setPhase("running");
              }
            }
            const cleanup = resolveSessionPlacementForcedTerminalSettlement();
            const releaseCleanup = cleanup && operation?.registerExecutionCleanup(cleanup);
            const startedAt = Date.now();
            laneTaskStartedAtMs = startedAt;
            const execution = (operation?.watchdog ?? executionWatchdog)?.beginExecution(
              () =>
                !capacityHeld || laneTaskDeadline?.kind === "unlimited"
                  ? undefined
                  : (laneTaskDeadline?.deadlineAtMs ??
                    Math.max(startedAt, laneTaskProgressAtMs) +
                      (opts?.taskTimeoutMs ?? laneTaskTimeoutMs)),
              recoverExecutionDeadline,
            );
            return task().finally(() => {
              execution?.close();
              releaseCleanup?.();
            });
          },
          () => {
            throwIfAborted();
            assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
            releaseQueuedContext("admitted");
            // Queue-stage rotation may rebind, but placement admitted into a retired runtime must fail.
            claimAgentRunContext(params.runId, {
              ...existingContext,
              agentId: params.agentId ?? existingContext?.agentId,
              sessionKey: params.sessionKey ?? existingContext?.sessionKey,
              sessionId: params.sessionId ?? existingContext?.sessionId,
              lifecycleGeneration,
              lastActiveAt: Date.now(),
            });
            // Queue dequeue can still block on writer or placement admission.
            finishGlobalLaneAdmission();
            waitingWatchdog?.progress("semantic", "global_capacity:admitted");
            params.replyOperation?.markGlobalLaneWaitEnded();
            params.onLaneWait?.({ waitMs: 0, queuedAhead: 0, waiting: false });
          },
        ),
      );
      const releaseTerminalProducerFence =
        writerClaim &&
        readSessionControllerOperationState(params.replyOperation)?.registerTerminalProducerFence(
          (isCurrent, fenceOptions) => writerClaim.revoke(isCurrent, fenceOptions),
        );
      return await laneExecution.finally(() => releaseTerminalProducerFence?.());
    };
    try {
      const { enqueue } = options.getParams();
      if (!enqueue) {
        noteLaneWaitIfBusy(options.globalLane);
      }
      // Only explicit preparation waits release capacity; timeouts retain raw-task custody.
      const queueOptions: CommandQueueAdmissionOptions = {
        taskIdentity,
        abortSignal,
        maxConcurrent: options.getParams().swarmExecutionLane?.maxConcurrent,
        priority: isBackgroundWorkLane(options.globalLane)
          ? "background"
          : sessionLanePolicy.priority,
        onQueued: () => {
          beginCapacityWait();
          noteCapacityWait();
          opts?.onQueued?.();
        },
        onWait: (waitMs, queuedAhead) => {
          opts?.onWait?.(waitMs, queuedAhead);
          options.getParams().onLaneWait?.({ waitMs, queuedAhead, waiting: true });
        },
        warnAfterMs: opts?.warnAfterMs,
      };
      let started = false;
      const queuedRun = withReleasableExecutionCapacity(
        (ticket) => {
          waitingForGlobalLaneAdmission = true;
          const runTicket = async () => {
            capacityHeld = true;
            activeGlobalCapacityTickets += 1;
            noteLaneTaskProgress();
            try {
              if (started) {
                endCapacityWait();
                assertCurrent();
                finishGlobalLaneAdmission();
                options.getParams().replyOperation?.markGlobalLaneWaitEnded();
                options.getParams().onLaneWait?.({ waitMs: 0, queuedAhead: 0, waiting: false });
              }
              started = true;
              return await ticket();
            } finally {
              capacityHeld = false;
              activeGlobalCapacityTickets -= 1;
            }
          };
          const queued = enqueue
            ? enqueue(runTicket, queueOptions)
            : enqueueCommandInLane(options.globalLane, runTicket, queueOptions);
          return queued.catch((error: unknown) => {
            // Cancel raw work before the capacity owner joins its cleanup.
            if (isCommandLaneTaskTimeoutError(error)) {
              laneTaskAbortController.abort(error);
            }
            throw error;
          });
        },
        () => trackGlobalExecution(taskWithCurrentLifecycle()),
      );
      return await trackGlobalExecution(queuedRun);
    } catch (error) {
      throw (abortSignal.aborted && resolveLaneTimeoutError()) || error;
    } finally {
      finishGlobalLaneAdmission();
    }
  };
  const enqueueAdmittedSession = async <T>(
    task: () => Promise<T>,
    opts?: CommandQueueEnqueueOptions,
  ) => {
    const operation = options.getParams().replyOperation;
    operation?.markWaitingForDeferredMaintenance();
    let releaseForeground: (() => void) | undefined;
    try {
      releaseForeground =
        sessionLanePolicy.priority === "foreground"
          ? await beginForegroundSessionMaintenance(
              options.getParams().sessionKey ?? options.getParams().sessionId,
            )
          : undefined;
    } finally {
      operation?.markDeferredMaintenanceWaitEnded();
    }
    // Mailbox and maintenance waits do not consume the admitted execution budget.
    noteLaneTaskProgress();
    try {
      let executing = true;
      const watchdog =
        operation?.watchdog ??
        createSessionControllerWatchdog({
          startedAtMs: Date.now(),
          isCurrent: () => executing,
          readPhase: () => (abortSignal.aborted ? "terminal" : "active"),
          requestStop: () => {
            laneTaskAbortController.abort(new Error("Detached execution stalled"));
            return "blocked";
          },
          expireCleanup: () => "blocked",
        });
      executionWatchdog = watchdog;
      if (!operation) {
        watchdog.start();
      }
      // Sessionless execution publishes no semantic progress; its deadline owns expiry.
      const detachedExecutionWait = operation
        ? undefined
        : watchdog.beginWait({
            kind: "runtime_owned",
            isCurrent: () => executing && !abortSignal.aborted,
          });
      const execution = watchdog.beginExecution(() => {
        if (
          (pendingGlobalExecutions.size > 0 && activeGlobalCapacityTickets === 0) ||
          ownedGlobalCapacityWaits > 0 ||
          operation?.phase === "waiting_for_deferred_maintenance" ||
          operation?.phase === "waiting_for_global_lane" ||
          laneTaskDeadline?.kind === "unlimited"
        ) {
          return undefined;
        }
        return (
          laneTaskDeadline?.deadlineAtMs ??
          laneTaskProgressAtMs + (opts?.taskTimeoutMs ?? laneTaskTimeoutMs)
        );
      }, recoverExecutionDeadline);
      const abortExecution = () => {
        laneTaskAbortedAtMs ??= Date.now();
        // A borrowed caller may cancel its nested producer without ending the
        // outer turn. Only the controller's own cancellation starts cleanup.
        if (!operation || operation.abortSignal.aborted) {
          watchdog.beginTerminal(Date.now() + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS);
        }
      };
      abortSignal.addEventListener("abort", abortExecution, { once: true });
      if (abortSignal.aborted) {
        abortExecution();
      }
      const unsubscribe = opts?.taskTimeoutSubscribe?.(setLaneTaskDeadline);
      try {
        throwIfAborted();
        endCapacityWait();
        return await task();
      } finally {
        executing = false;
        detachedExecutionWait?.close();
        execution.close();
        unsubscribe?.();
        abortSignal.removeEventListener("abort", abortExecution);
        executionWatchdog = undefined;
        if (!operation) {
          watchdog.close();
        }
      }
    } finally {
      releaseForeground?.();
    }
  };

  const enqueueSession = async <T>(task: () => Promise<T>, opts?: CommandQueueEnqueueOptions) => {
    const params = options.getParams();
    // Retain queued context before mailbox admission, not only after a lane starts.
    releaseQueuedRunContext = retainQueuedAgentRunContext(
      params.runId,
      options.getLifecycleGeneration(),
    );
    queuedRunAbortSignal = abortSignal;
    abortSignal.addEventListener("abort", abandonQueuedContext, { once: true });
    if (abortSignal.aborted) {
      abandonQueuedContext();
    }
    try {
      return await withSessionTurn(
        {
          ...params,
          storePath:
            params.sessionTarget?.storePath ??
            (params.config
              ? resolveSessionStorePathCore(params.config.session?.store, {
                  agentId: params.agentId,
                })
              : undefined),
          detached: params.sessionPersistence === "detached",
          abortSignal,
        },
        async (operation, turnSignal) => {
          options.setParams({
            ...options.getParams(),
            replyOperation: operation,
            abortSignal: turnSignal,
          });
          const abortTurn = () => laneTaskAbortController.abort(turnSignal.reason);
          turnSignal.addEventListener("abort", abortTurn, { once: true });
          if (turnSignal.aborted) {
            abortTurn();
          }
          try {
            if (operation) {
              assertSessionControllerOperation(operation);
            }
            // Raw producer settlement owns release; no per-session command queue.
            try {
              return await enqueueAdmittedSession(task, opts);
            } finally {
              // Never complete the operation while an admitted task or its cleanup can write.
              while (pendingGlobalExecutions.size) {
                await Promise.allSettled(pendingGlobalExecutions);
              }
            }
          } finally {
            turnSignal.removeEventListener("abort", abortTurn);
          }
        },
      );
    } finally {
      releaseQueuedContext("abandoned");
    }
  };

  return {
    enqueueGlobal,
    enqueueSession,
    abortSignal,
    laneTaskAbortController,
    noteLaneTaskProgress,
    setLaneTaskDeadline,
    // Preparation has its own run budget; active auth uses execution time, without teardown grace.
    getExecutionDeadline: (): CommandQueueTaskDeadline | undefined =>
      !activeAttemptOwner
        ? undefined
        : laneTaskDeadline?.kind === "bounded"
          ? {
              kind: "bounded",
              deadlineAtMs: laneTaskDeadline.deadlineAtMs - EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
            }
          : laneTaskDeadline,
    createAttemptControls,
    throwIfAborted,
    assertCurrent,
  };
}
