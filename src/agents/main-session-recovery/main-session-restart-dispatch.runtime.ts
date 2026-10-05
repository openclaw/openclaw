import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/index.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import { sanitizePendingFinalDeliveryText } from "../../auto-reply/reply/pending-final-delivery-state.js";
import { isInitialQueuedMainSessionInput } from "../../config/sessions/main-session-recovery.types.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { preparePhysicalSessionStorePath } from "../../config/sessions/session-store-path.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { CommandLane } from "../../process/lanes.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { getOwedHarnessCompletionTask } from "../agent-harness-completion-recovery.js";
import { listSubagentRunsForRequester } from "../subagents/registry/subagent-registry-read.js";
import { buildSubagentRestartRecoveryRoster } from "../subagents/subagent-restart-recovery-prompt.js";
import type { MainSessionRecoveryAdmission } from "./main-session-recovery-admission.js";
import { prepareRestartRecoveryAcceptedInput } from "./main-session-recovery-current-input.js";
import { repairMainSessionRecoveryMutation } from "./main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import {
  isCapturedMainRestartGoalCurrent,
  type MainSessionRecoveryReservation,
} from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import {
  acquireRestartRecoveryCapacity,
  dispatchRestartRecoveryWithinCapacity,
} from "./main-session-restart-dispatch-capacity.js";
import {
  hasRestartRecoveryMessageActionAuthority,
  requiresRestartRecoveryMessageActionAuthority,
  buildResumeMessage,
} from "./main-session-restart-dispatch-message.js";
import {
  createStartedRecoverySettlement,
  rollbackRestartRecoveryReservation,
  scheduleRestartRecoveryReservationRollback,
  settleAcceptedRestartRecovery,
} from "./main-session-restart-dispatch-settlement.js";
import {
  normalizeRestartRecoveryTerminalStatus,
  probeRestartRecoveryTerminalStatus,
} from "./main-session-restart-dispatch-start.js";
import type {
  MainSessionResumeResult,
  MainSessionRecoveryAuthorityHold,
  ResumeMainSessionParams,
} from "./main-session-restart-dispatch.types.js";
import {
  announceRestartRecoveryResumption,
  isRestartRecoveryDeliveryCurrent,
  prepareRestartRecoveryDeliveryFacts,
  resolveRestartRecoveryDeliveryContext,
} from "./main-session-restart-recovery-delivery.js";
import {
  mainSessionRecoveryLog as log,
  readInterruptedRunId,
} from "./main-session-restart-recovery-shared.js";

export async function resumeMainSessionWithinAdmission(
  input: ResumeMainSessionParams & {
    recoveryAdmission: MainSessionRecoveryAdmission;
    assertSourceCurrent: () => void;
  },
): Promise<MainSessionResumeResult> {
  let params = input;
  const holdAuthority = (
    reason: MainSessionRecoveryAuthorityHold["reason"],
  ): MainSessionRecoveryAuthorityHold => ({
    kind: "authority-hold",
    reason,
    observation: params.observation,
    source: structuredClone({
      mainRestartRecovery: params.entry.mainRestartRecovery,
      restartRecoveryGoal: params.entry.restartRecoveryGoal,
      restartRecoveryDeliverySourceRunId: params.entry.restartRecoveryDeliverySourceRunId,
      restartRecoveryDeliveryRunId: params.entry.restartRecoveryDeliveryRunId,
      lifecycleRunId: params.entry.lifecycleRunId,
    }),
  });

  if (params.shouldContinue?.() === false) {
    return "skipped";
  }
  if (
    params.entry.mainRestartRecovery?.goalIntent &&
    !params.entry.restartRecoveryGoal &&
    !params.entry.mainRestartRecovery.turnIntent
  ) {
    log.warn("Original goal issuer is unavailable without a captured recovery marker");
    return holdAuthority("missing-goal-marker");
  }
  const harnessCompletion = params.entry.restartRecoveryHarnessCompletion;
  const taskRemainsOwed = () =>
    !harnessCompletion || Boolean(getOwedHarnessCompletionTask(harnessCompletion, params.entry));
  if (!taskRemainsOwed()) {
    return "skipped";
  }
  const lifecycleGeneration = params.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  const sanitizedPendingText =
    typeof params.pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(params.pendingFinalDeliveryText)
      : "";
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  const claimedRunId = normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId);
  const claimedSourceRunId = normalizeOptionalString(
    params.entry.restartRecoveryDeliverySourceRunId,
  );
  // Preserve the interrupted turn's identity so its completion observer can
  // join this successor. Run correlation does not create channel authority.
  const sourceRunId = claimedSourceRunId ?? readInterruptedRunId(params.entry);
  if (
    requiresRestartRecoveryMessageActionAuthority(params.entry) &&
    !hasRestartRecoveryMessageActionAuthority(params.entry)
  ) {
    log.warn(`refusing message-tool-only recovery without channel authority: ${params.sessionKey}`);
    return "failed";
  }
  const claimedRunWasAdmittedBeforeRestart =
    claimedRunId !== undefined &&
    params.entry.restartRecoveryRuns?.some(
      (run) => run.runId === claimedRunId && run.lifecycleGeneration !== lifecycleGeneration,
    ) === true;
  const recoveryRunId =
    isInitialQueuedMainSessionInput(params.entry) && sourceRunId
      ? sourceRunId
      : claimedRunId && claimedRunId !== sourceRunId && !claimedRunWasAdmittedBeforeRestart
        ? claimedRunId
        : randomUUID();
  const reusingRecoveryRunId = recoveryRunId === claimedRunId;
  const dispatchSessionKey = params.canonicalSessionKey ?? params.sessionKey;
  const target = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
  const settlementTarget = {
    ...target,
    expectedRecoveryRunId: recoveryRunId,
    expectedRecoverySourceRunId: sourceRunId,
    expectedSessionId: params.entry.sessionId,
    lifecycleGeneration,
    sessionKeys: Array.from(new Set([dispatchSessionKey, params.sessionKey])),
    shouldContinue: () => params.shouldContinue?.() !== false,
    assertCurrent,
  };
  let reservation: MainSessionRecoveryReservation | undefined;
  let dispatchStarted = false;
  let dispatchAccepted = false;
  let executionStarted = false;
  let preStartAbortAttempted = false;
  let preStartAbortConfirmed = false;
  let releaseCapacity: (() => void) | undefined;
  let capacityTransferred = false;
  let deliveryFacts: Awaited<ReturnType<typeof prepareRestartRecoveryDeliveryFacts>> | undefined;
  let deliveryTransferred = false;
  let releaseDeliveryOperator: (() => void) | undefined;
  const releaseDelivery = () => {
    const facts = deliveryFacts;
    const releaseOperator = releaseDeliveryOperator;
    deliveryFacts = undefined;
    releaseDeliveryOperator = undefined;
    try {
      facts?.release();
    } finally {
      releaseOperator?.();
    }
  };
  let operatorRecovery:
    | Awaited<ReturnType<NonNullable<GatewayRecoveryRuntime["prepareGoalRecoveryAuthority"]>>>
    | undefined;
  function assertCurrent() {
    params.assertSourceCurrent();
    operatorRecovery?.authority.assertCurrent();
  }
  const rollbackReservation = async (kind: "abandon_reservation" | "cancel_reservation") => {
    if (!reservation) {
      return undefined;
    }
    const result = await rollbackRestartRecoveryReservation({
      ...target,
      kind,
      reservation,
    });
    reservation = undefined;
    return result;
  };
  const restoreAcceptedRecovery = async () => {
    if (params.shouldContinue?.() === false) {
      return undefined;
    }
    const restored = await commitMainSessionRecovery({
      command: {
        kind: "mark_admitted_recovery_interrupted",
        cycleId: params.observation.cycleId,
        attempt: params.recoveryAttempt,
        lifecycleGeneration,
        now: Date.now(),
        runId: recoveryRunId,
        sessionId: params.entry.sessionId,
      },
      requireWriteSuccess: true,
      shouldContinue: params.shouldContinue,
      target,
    });
    return params.shouldContinue?.() !== false &&
      (restored.transition.kind === "applied" || restored.transition.kind === "no_change") &&
      restored.entry &&
      restored.sessionKey
      ? {
          ...target,
          sessionId: restored.entry.sessionId,
          sessionKey: restored.sessionKey,
        }
      : undefined;
  };
  const repairAcceptedRecovery = async () => {
    const restored = await repairMainSessionRecoveryMutation({
      mutation: restoreAcceptedRecovery,
      onDeferredSuccess: scheduleMainSessionRecoveryPendingTarget,
      onError: (restoreError) => {
        if (params.shouldContinue?.() !== false) {
          log.warn(
            `failed to restore ambiguous restart recovery ${params.sessionKey}: ${String(restoreError)}`,
          );
        }
      },
    });
    if (params.shouldContinue?.() !== false) {
      scheduleMainSessionRecoveryPendingTarget(restored);
    }
  };
  try {
    if (
      params.entry.mainRestartRecovery?.queuedInputId ||
      params.entry.restartRecoveryGoal ||
      process.env.FACTORY_AUTH_MODE === "github"
    ) {
      const intent =
        params.entry.restartRecoveryGoal && !params.entry.mainRestartRecovery?.queuedInputId
          ? params.entry.mainRestartRecovery?.goalIntent
          : params.entry.mainRestartRecovery?.turnIntent;
      const prepare = params.gatewayRuntime.prepareGoalRecoveryAuthority;
      if (!intent || !prepare || ("runId" in intent && intent.runId !== sourceRunId)) {
        log.warn(
          `holding restart recovery without the original accepted issuer: ${params.sessionKey}`,
        );
        return holdAuthority(
          !intent ? "missing-intent" : !prepare ? "missing-restorer" : "source-mismatch",
        );
      }
      const acceptedTurn =
        "goalId" in intent ? params.entry.mainRestartRecovery?.turnIntent : undefined;
      if (
        acceptedTurn &&
        acceptedTurn.runId !== sourceRunId &&
        acceptedTurn.runId !== recoveryRunId
      ) {
        log.warn(`holding restart recovery with a changed accepted source: ${params.sessionKey}`);
        return holdAuthority("source-mismatch");
      }
      try {
        operatorRecovery = await prepare(intent, {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          ...(acceptedTurn ? { acceptedTurn } : {}),
        });
      } catch (error) {
        if (!acceptedTurn) {
          throw error;
        }
        log.warn(
          `holding restart recovery without current Goal and accepted issuer authority: ${params.sessionKey}`,
        );
        return "skipped";
      }
      operatorRecovery.authority.assertCurrent();
      const shouldContinue = params.shouldContinue;
      const authority = operatorRecovery.authority;
      params = {
        ...params,
        shouldContinue: () => {
          if (shouldContinue?.() === false) {
            return false;
          }
          try {
            authority.assertCurrent();
            return true;
          } catch {
            return false;
          }
        },
      };
    }
    const capacity = await acquireRestartRecoveryCapacity({
      capacity: params.recoveryCapacity,
      observation: params.observation,
      lifecycleGeneration,
      runId: recoveryRunId,
      shouldContinue: () => params.shouldContinue?.() !== false,
      assertCurrent,
      target,
    });
    if (!capacity) {
      return "skipped";
    }
    releaseCapacity = capacity.release;
    const reserved = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: params.recoveryAttempt,
        lifecycleGeneration,
        now: Date.now(),
        observation: capacity.observation,
        runId: recoveryRunId,
        executionIdentity: isExecutionIdentityCollectionEnabled(params.cfg)
          ? { state: "enabled" }
          : { state: "disabled" },
      },
      requireWriteSuccess: true,
      shouldContinue: params.shouldContinue,
      assertCommitAllowed: assertCurrent,
      target,
    });
    if (reserved.transition.kind !== "reserved") {
      return "skipped";
    }
    reservation = reserved.transition.reservation;
    if (params.shouldContinue?.() === false || !taskRemainsOwed()) {
      await rollbackReservation("cancel_reservation");
      return "skipped";
    }
    const acceptedText = await prepareRestartRecoveryAcceptedInput({
      entry: params.entry,
      prepareAcceptedInput: operatorRecovery?.prepareAcceptedInput,
      assertCurrent,
      cancelReservation: () => rollbackReservation("cancel_reservation"),
      assertDispatchCurrent: () => {
        if (params.shouldContinue?.() === false || !taskRemainsOwed()) {
          throw new Error("Original accepted input recovery owner changed");
        }
      },
    });
    if (typeof acceptedText === "object") {
      return acceptedText;
    }
    const queuedInput = isInitialQueuedMainSessionInput(params.entry);
    if (queuedInput && acceptedText === undefined) {
      throw new Error("Queued recovery has no verified accepted plaintext input");
    }
    // Persist one stable RPC id before dispatch. A transport rejection is
    // ambiguous; retries must reuse this id so accepted work cannot duplicate.
    const recoveryStatePrepared = await applySessionEntryReplacements({
      agentId: target.agentId,
      sessionKeys: [params.sessionKey],
      storePath: params.storePath,
      assertCommitAllowed: assertCurrent,
      update: (entries) => {
        if (params.shouldContinue?.() === false || !taskRemainsOwed()) {
          return { result: false };
        }
        const current = entries.find((entry) => entry.sessionKey === params.sessionKey);
        const entry = current?.entry;
        if (
          !entry ||
          entry.sessionId !== params.entry.sessionId ||
          (harnessCompletion &&
            (entry.lifecycleRevision !== harnessCompletion.lifecycleRevision ||
              entry.restartRecoveryHarnessCompletion?.taskId !== harnessCompletion.taskId)) ||
          entry.abortedLastRun !== true ||
          normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !== claimedRunId ||
          normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) !==
            claimedSourceRunId ||
          (!claimedSourceRunId && readInterruptedRunId(entry) !== sourceRunId)
        ) {
          return { result: false };
        }
        // Freeze the resolved legacy route before the new claim disables session fallback.
        if (!claimedRunId && deliveryContext) {
          entry.restartRecoveryDeliveryContext = deliveryContext;
        }
        entry.restartRecoveryDeliveryRunId = recoveryRunId;
        entry.restartRecoveryDeliverySourceRunId = sourceRunId;
        entry.restartRecoveryForceSafeTools = params.forceRestartSafeTools ? true : undefined;
        entry.updatedAt = Date.now();
        return {
          result: true,
          replacements: [{ sessionKey: params.sessionKey, entry }],
        };
      },
    });
    if (!recoveryStatePrepared) {
      const rollback = await rollbackReservation("cancel_reservation");
      if (params.shouldContinue?.() === false) {
        return "skipped";
      }
      const current = rollback?.entry;
      return current?.sessionId === params.entry.sessionId &&
        current.abortedLastRun === true &&
        !current.mainRestartRecovery?.reservation &&
        !current.mainRestartRecovery?.tombstone
        ? "failed"
        : "skipped";
    }
    const requesterStorePath = await preparePhysicalSessionStorePath({
      agentId: params.agentId,
      sessionKey: dispatchSessionKey,
      storePath: params.storePath,
    });
    const agentParams: AgentRunRequest = {
      agentId: params.agentId,
      message:
        queuedInput && acceptedText !== undefined
          ? acceptedText
          : buildResumeMessage(
              sanitizedPendingText,
              params.forceRestartSafeTools,
              buildSubagentRestartRecoveryRoster(
                listSubagentRunsForRequester(dispatchSessionKey, {
                  requesterAgentId: params.agentId,
                  requesterSessionId: params.entry.sessionId,
                  requesterLifecycleRevision: params.entry.lifecycleRevision,
                  requesterStorePath,
                }),
              ),
              isCapturedMainRestartGoalCurrent(params.entry),
            ),
      sessionKey: dispatchSessionKey,
      expectedExistingSessionId: params.entry.sessionId,
      internalRuntimeHandoffId: params.recoveryAdmission.handoffId,
      ...(isExecutionIdentityCollectionEnabled(params.cfg)
        ? { internalExecutionIdentityRetry: params.recoveryAttempt > 1 }
        : {}),
      internalExecutionIdentityRecoveryAttempt: params.recoveryAttempt,
      idempotencyKey: recoveryRunId,
      deliver:
        Boolean(deliveryContext) &&
        params.entry.restartRecoverySourceReplyDeliveryMode !== "message_tool_only",
      lane: CommandLane.Main,
      ...(params.entry.restartRecoverySourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: params.entry.restartRecoverySourceReplyDeliveryMode }
        : {}),
      ...(params.forceRestartSafeTools ? { forceRestartSafeTools: true } : {}),
      ...(params.forceCodeModeTools ? { forceCodeModeTools: true } : {}),
      inputProvenance: {
        kind: "internal_system",
        sourceSessionKey: dispatchSessionKey,
        sourceTool: MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL,
      },
    };
    if (deliveryContext) {
      agentParams.channel = deliveryContext.channel;
      agentParams.to = deliveryContext.to;
      agentParams.bestEffortDeliver = true;
      if (deliveryContext.accountId) {
        agentParams.accountId = deliveryContext.accountId;
      }
      if (deliveryContext.threadId != null) {
        agentParams.threadId = String(deliveryContext.threadId);
      }
    }
    if (params.shouldContinue?.() === false || !taskRemainsOwed()) {
      await rollbackReservation("cancel_reservation");
      return "skipped";
    }
    if (params.forceRestartSafeTools) {
      log.info(`dispatching restart-safe recovery for ${params.sessionKey}`);
    }
    let dispatchSettled = false;
    if (agentParams.deliver && deliveryContext) {
      deliveryFacts = await prepareRestartRecoveryDeliveryFacts({
        ...target,
        agentId: params.agentId,
        sessionKey: dispatchSessionKey,
        sessionId: params.entry.sessionId,
        lifecycleRevision: params.entry.lifecycleRevision,
      });
      assertCurrent();
      if (operatorRecovery) {
        const retain = operatorRecovery.authority.retain;
        if (!retain) {
          throw new Error("Restart recovery delivery cannot retain its original issuer");
        }
        releaseDeliveryOperator = retain();
      }
    }
    dispatchStarted = true;
    capacityTransferred = true;
    const startedAdmission = createStartedRecoverySettlement(settlementTarget);
    let stopTyping: (() => void) | undefined;
    const dispatchOutcome = await dispatchRestartRecoveryWithinCapacity({
      agentParams,
      operatorRunAuthority: operatorRecovery?.authority,
      releaseCapacity,
      beginDispatch: params.recoveryAdmission.beginDispatch,
      gatewayRuntime: params.gatewayRuntime,
      onStarted: startedAdmission.onStarted,
      onSettled: () => {
        dispatchSettled = true;
        try {
          stopTyping?.();
        } finally {
          releaseDelivery();
        }
      },
      shouldContinue: () => params.shouldContinue?.() !== false,
    });
    if (!dispatchOutcome) {
      dispatchStarted = false;
      await rollbackReservation("cancel_reservation");
      return "skipped";
    }
    ({ dispatchAccepted, executionStarted, preStartAbortAttempted, preStartAbortConfirmed } =
      dispatchOutcome.observation);
    if (dispatchOutcome.kind === "failed") {
      throw dispatchOutcome.error;
    }
    const dispatchResult =
      dispatchOutcome.kind === "terminal"
        ? dispatchOutcome.result
        : { runId: recoveryRunId, status: "accepted" };
    if (params.shouldContinue?.() === false) {
      // The accepted run belongs to its original Gateway; never let a stopped
      // owner settle or transfer that durable claim into a new lifecycle.
      return "skipped";
    }
    // Reconcile accepted and terminal outcomes idempotently with durable admission.
    let terminalStatus = normalizeRestartRecoveryTerminalStatus(dispatchResult.status);
    if (
      !executionStarted &&
      !terminalStatus &&
      reusingRecoveryRunId &&
      dispatchResult.status === "accepted"
    ) {
      terminalStatus = await probeRestartRecoveryTerminalStatus(
        recoveryRunId,
        params.gatewayRuntime,
      );
    }
    if (!executionStarted && !terminalStatus) {
      throw new Error(
        `restart recovery dispatch ended before execution started: ${params.sessionKey}`,
      );
    }
    if (params.shouldContinue?.() === false) {
      return "skipped";
    }
    if (!(await startedAdmission.settle(terminalStatus))) {
      throw new Error(`restart recovery admission changed before settlement: ${params.sessionKey}`);
    }
    if (params.shouldContinue?.() === false) {
      return "skipped";
    }
    const resumeResult = terminalStatus ? "settled" : "started";
    if (
      resumeResult === "started" &&
      !dispatchSettled &&
      agentParams.deliver &&
      deliveryContext &&
      taskRemainsOwed()
    ) {
      const retainedDelivery = deliveryFacts;
      if (!retainedDelivery) {
        throw new Error("Restart recovery delivery has no retained owner");
      }
      deliveryTransferred = !dispatchSettled;
      const shouldContinueDelivery = () => {
        try {
          operatorRecovery?.authority.assertCurrent();
          return (
            !dispatchSettled && taskRemainsOwed() && input.shouldContinueDelivery?.() !== false
          );
        } catch {
          return false;
        }
      };
      if (!dispatchSettled) {
        stopTyping = params.gatewayRuntime.startRecoveryTyping?.({
          ...deliveryContext,
          agentId: params.agentId,
          runId: recoveryRunId,
          isCurrent: (cfg) =>
            !dispatchSettled &&
            taskRemainsOwed() &&
            isRestartRecoveryDeliveryCurrent({
              ...target,
              sessionKey: dispatchSessionKey,
              sessionId: params.entry.sessionId,
              recoveryRunId,
              lifecycleGeneration,
              deliveryContext,
              cfg,
              shouldContinue: shouldContinueDelivery,
              readCurrent: retainedDelivery.readCurrent,
            }),
        });
      }
      await announceRestartRecoveryResumption({
        ...target,
        sessionKey: dispatchSessionKey,
        sessionId: params.entry.sessionId,
        recoveryRunId,
        lifecycleGeneration,
        deliveryContext,
        cfg: params.cfg,
        shouldContinue: shouldContinueDelivery,
        readCurrent: retainedDelivery.readCurrent,
        gatewayRuntime: params.gatewayRuntime,
      });
    }
    log.info(
      `${resumeResult} interrupted main session: ${params.sessionKey}${
        sanitizedPendingText ? " (with pending payload)" : ""
      }`,
    );
    return resumeResult;
  } catch (error) {
    const explicitlyRejected = error instanceof GatewayClientRequestError && !dispatchAccepted;
    const canRestoreAcceptedFailure = !preStartAbortAttempted || preStartAbortConfirmed;
    if (
      dispatchAccepted &&
      !executionStarted &&
      canRestoreAcceptedFailure &&
      params.shouldContinue?.() !== false
    ) {
      await repairAcceptedRecovery();
    } else if (
      dispatchAccepted &&
      !executionStarted &&
      preStartAbortAttempted &&
      !preStartAbortConfirmed &&
      params.shouldContinue?.() !== false
    ) {
      log.warn(
        `restart recovery execution start timed out without confirmed cancellation: ${params.sessionKey}`,
      );
    }
    try {
      if (dispatchStarted && !explicitlyRejected && params.shouldContinue?.() !== false) {
        const terminalStatus = await probeRestartRecoveryTerminalStatus(
          recoveryRunId,
          params.gatewayRuntime,
        );
        if (terminalStatus && params.shouldContinue?.() !== false) {
          const settled = await settleAcceptedRestartRecovery({
            ...settlementTarget,
            reservation,
            terminalStatus,
          });
          if (!settled) {
            log.warn(`restart recovery admission changed before settlement: ${params.sessionKey}`);
          } else if (params.shouldContinue?.() !== false) {
            log.info(`observed terminal restart recovery for ${params.sessionKey}`);
            return "settled";
          }
        }
      }
    } catch (settlementError) {
      if (params.shouldContinue?.() !== false) {
        log.warn(
          `failed to settle ambiguous restart recovery ${params.sessionKey}: ${String(settlementError)}`,
        );
        await repairAcceptedRecovery();
      }
    }
    if (reservation) {
      const rollbackKind =
        dispatchStarted && !explicitlyRejected ? "abandon_reservation" : "cancel_reservation";
      await rollbackReservation(rollbackKind).catch((rollbackError: unknown) => {
        log.warn(
          `failed to roll back interrupted main session recovery attempt ${params.sessionKey}: ${String(rollbackError)}`,
        );
        scheduleRestartRecoveryReservationRollback({
          ...target,
          kind: rollbackKind,
          reservation: reservation!,
        });
      });
    }
    if (params.shouldContinue?.() === false) {
      return "skipped";
    }
    log.warn(
      `failed to resume interrupted main session ${params.sessionKey}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return "failed";
  } finally {
    try {
      if (!deliveryTransferred) {
        releaseDelivery();
      }
    } finally {
      try {
        operatorRecovery?.release();
      } finally {
        if (!capacityTransferred) {
          releaseCapacity?.();
        }
      }
    }
  }
}
