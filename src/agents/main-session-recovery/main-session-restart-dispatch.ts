import { randomUUID } from "node:crypto";
import { formatErrorStackWithMessage } from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/index.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import { stripInternalMetadataForDisplay } from "../../auto-reply/reply/display-text-sanitize.js";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntryCurrentFacts } from "../../config/sessions/session-entry-current.types.js";
import { withSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import { preparePhysicalSessionStorePath } from "../../config/sessions/session-store-path.js";
import { bindInProcessSessionRun } from "../../gateway/in-process-session-run.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  reserveOrJoinSessionControllerSource,
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.metadata.js";
import { getOwedHarnessCompletionTask } from "../agent-harness-completion-recovery.js";
import { runWithAgentToolSourceExecutionScope } from "../agent-tool-source-execution-guard.js";
import { RESTART_RECOVERY_INTERRUPTION_NOTE } from "../restart-recovery-prompt.js";
import { listSubagentRunsForRequester } from "../subagents/registry/subagent-registry-read.js";
import {
  buildSubagentRestartRecoveryRoster,
  SUBAGENT_RESTART_RECOVERY_INSTRUCTION,
} from "../subagents/subagent-restart-recovery-prompt.js";
import { TOOL_FAILURE_INSTRUCTION } from "../tool-outcome-instructions.js";
import { repairMainSessionRecoveryMutation } from "./main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import type { MainSessionRecoveryReservation } from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import {
  rollbackRestartRecoveryReservation,
  settleAcceptedRestartRecovery,
  settleRejectedRestartRecovery,
} from "./main-session-restart-dispatch-settlement.js";
import {
  dispatchRestartRecoveryUntilStarted,
  normalizeRestartRecoveryTerminalStatus,
  probeRestartRecoveryTerminalStatus,
} from "./main-session-restart-dispatch-start.js";
import type { ResumeMainSessionParams } from "./main-session-restart-dispatch.types.js";
import {
  announceRestartRecoveryResumption,
  hasRestartRecoveryMessageActionAuthority,
  requiresRestartRecoveryMessageActionAuthority,
  prepareRestartRecoveryDeliveryCurrent,
  resolveRestartRecoveryDeliveryContext,
} from "./main-session-restart-recovery-delivery.js";
import {
  mainSessionRecoveryLog as log,
  readInterruptedRunId,
  resolveRestartResendReservationId,
} from "./main-session-restart-recovery-shared.js";

const RESTART_RECOVERY_RESUME_MESSAGE = formatSystemTurnPrompt(
  `${RESTART_RECOVERY_INTERRUPTION_NOTE} The restart did not cancel the user's task. ` +
    "Continue from the existing transcript: check the current state and continue permitted work. " +
    "Before promising or attempting further action, check this turn's available tools and " +
    "recorded approval outcomes. Do not ask the user to repeat the request solely because a " +
    "restart occurred. If further action requires a fresh user request, explain that requirement " +
    "instead of promising or attempting a retry, replacement, or fallback. " +
    `${SUBAGENT_RESTART_RECOVERY_INSTRUCTION} Treat a tool result ` +
    "marked interrupted or missing as having an unknown outcome; verify the operation's recorded " +
    "state before repeating an action or reporting whether it happened. Recovery permission facts " +
    "do not establish execution outcomes. Missing fallback artifacts or unavailable tools do not " +
    "prove that an earlier action did not run. If the available tools cannot establish its outcome, " +
    `report it as unknown. ${TOOL_FAILURE_INSTRUCTION}`,
);

const RESTART_SAFE_TOOLS_NOTICE =
  "For this turn only, the tool surface has been narrowed to replay-safe tools as a " +
  "recovery precaution. Use the tools that are available to report status or continue " +
  "read-only work; the full tool surface restores on the next user turn.";

function buildResumeMessage(
  pendingFinalDeliveryText: string,
  forceRestartSafeTools?: boolean,
  childRecoveryRoster?: string,
): string {
  const instructions = forceRestartSafeTools
    ? `${RESTART_RECOVERY_RESUME_MESSAGE}\n\n${RESTART_SAFE_TOOLS_NOTICE}`
    : RESTART_RECOVERY_RESUME_MESSAGE;
  const base = childRecoveryRoster ? `${instructions}\n\n${childRecoveryRoster}` : instructions;
  return pendingFinalDeliveryText
    ? `${base}\n\nNote: The interrupted final reply was captured: "${pendingFinalDeliveryText}"`
    : base;
}

type MainSessionResumeResult = "started" | "settled" | "skipped" | "failed";

/** Resends one interrupted main-session turn as a mailbox input after winning its durable attempt. */
export async function resumeMainSession(
  params: ResumeMainSessionParams,
): Promise<MainSessionResumeResult> {
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let retainedByDispatch = false;
  let dispatchSettled = false;
  using _ = {
    [Symbol.dispose]: () => {
      if (!retainedByDispatch || dispatchSettled) {
        retained?.release();
        params.releaseCompletionSource?.();
      }
    },
  };
  const source = captureSessionEntryMetadataRead(params, () => {});
  const matchesRequester = (current: SessionEntryCurrentFacts | undefined) =>
    current?.sessionId === params.entry.sessionId &&
    current.lifecycleRevision === params.entry.lifecycleRevision;
  if (!source) {
    let databaseIdentity: string | undefined;
    await withSessionEntriesFromStoreInWorker(
      { ...params, sessionKeys: [params.sessionKey], projection: "list" },
      async (read) => {
        const entry = read.result.entries.find(
          ({ sessionKey }) => sessionKey === params.sessionKey,
        )?.entry;
        if (databaseIdentity && entry?.sessionId === params.entry.sessionId) {
          retained = retainPreparedSessionEntryPredicate({
            databaseIdentity,
            sessionKey: params.sessionKey,
            entry,
            matches: (_before, current) => matchesRequester(current),
          });
        }
      },
      false,
      (_database, identity) => {
        databaseIdentity = identity.key;
      },
    );
  }
  const isCurrent = () =>
    source ? matchesRequester(source.readCurrent()) : retained?.isCurrent() === true;
  if (!isCurrent()) {
    return "skipped";
  }
  // Wait for execution capacity before charging an attempt or reserving its mailbox input.
  // The controller remains the only session owner after this lane barrier releases.
  const lane = params.lane ?? CommandLane.RestartRecovery;
  const signal = params.signal ?? params.controllerInput?.abortSignal;
  await enqueueCommandInLane(lane, async () => {}, {
    priority: lane === CommandLane.RestartRecovery ? "background" : "normal",
    abortSignal: signal
      ? AbortSignal.any([signal, getGatewayRestartDrainSignal()])
      : getGatewayRestartDrainSignal(),
  });
  if (!isCurrent() || params.shouldContinue?.() === false) {
    return "skipped";
  }
  const result = await resumeMainSessionWithinAdmission(
    {
      ...params,
      shouldContinue: () => params.shouldContinue?.() !== false && isCurrent(),
    },
    () => {
      dispatchSettled = true;
      if (retainedByDispatch) {
        retained?.release();
        params.releaseCompletionSource?.();
      }
    },
  );
  // Execution start returns before the admitted run finishes using this source.
  retainedByDispatch = result === "started" && !dispatchSettled;
  return result;
}

async function resumeMainSessionWithinAdmission(
  params: ResumeMainSessionParams,
  onDispatchSettled: () => void,
): Promise<MainSessionResumeResult> {
  if (params.shouldContinue?.() === false) {
    return "skipped";
  }
  const harnessCompletion = params.entry.restartRecoveryHarnessCompletion;
  const source = captureSessionEntryMetadataRead(params, () => {});
  const taskRemainsOwed = () => {
    params.completionSource?.();
    if (!harnessCompletion) {
      return true;
    }
    const entry = source ? source.readCurrent() : params.entry;
    return Boolean(entry && getOwedHarnessCompletionTask(harnessCompletion, entry));
  };
  if (!taskRemainsOwed()) {
    return "skipped";
  }
  const lifecycleGeneration = params.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  const sanitizedPendingText =
    typeof params.pendingFinalDeliveryText === "string"
      ? stripInternalMetadataForDisplay(params.pendingFinalDeliveryText)
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
    claimedRunId &&
    claimedRunId !== sourceRunId &&
    // Queued input keeps its transcript key as the source, not a new recovery reservation.
    buildRunUserTurnIdempotencyKey(claimedRunId) !== sourceRunId &&
    !claimedRunWasAdmittedBeforeRestart
      ? claimedRunId
      : randomUUID();
  const reusingRecoveryRunId = recoveryRunId === claimedRunId;
  const dispatchSessionKey = params.canonicalSessionKey ?? params.sessionKey;
  const target = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
  let deliveryCurrent:
    | Awaited<ReturnType<typeof prepareRestartRecoveryDeliveryCurrent>>
    | undefined;
  let retainDeliveryCurrent = false;
  const settlementTarget = {
    ...target,
    expectedRecoveryRunId: recoveryRunId,
    expectedRecoverySourceRunId: sourceRunId,
    expectedSessionId: params.entry.sessionId,
    pendingFinalDelivery: params.entry.pendingFinalDelivery,
    lifecycleGeneration,
    sessionKeys: Array.from(new Set([dispatchSessionKey, params.sessionKey])),
    shouldContinue: params.shouldContinue,
  };
  let reservation: MainSessionRecoveryReservation | undefined;
  let ownedInput: SessionControllerInput | undefined;
  let controllerInput = params.controllerInput;
  let dispatchStarted = false;
  let dispatchAccepted = false;
  let executionStarted = false;
  let preStartAbortAttempted = false;
  let preStartAbortConfirmed = false;
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
    const reserved = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: params.recoveryAttempt,
        lifecycleGeneration,
        now: Date.now(),
        observation: params.observation,
        runId: recoveryRunId,
        executionIdentity: isExecutionIdentityCollectionEnabled(params.cfg)
          ? { state: "enabled" }
          : { state: "disabled" },
      },
      requireWriteSuccess: true,
      shouldContinue: params.shouldContinue,
      target,
    });
    if (reserved.transition.kind !== "reserved") {
      return "skipped";
    }
    reservation = reserved.transition.reservation;
    const inputReservationId = resolveRestartResendReservationId(reservation);
    if (params.shouldContinue?.() === false || !taskRemainsOwed()) {
      await rollbackReservation("cancel_reservation");
      return "skipped";
    }
    // Reuse one RPC id on retries: transport rejection does not prove the dispatch was rejected.
    const recoveryStatePrepared = await applySessionEntryReplacements({
      agentId: target.agentId,
      sessionKeys: [params.sessionKey],
      storePath: params.storePath,
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
      message: buildResumeMessage(
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
      ),
      sessionKey: dispatchSessionKey,
      expectedExistingSessionId: params.entry.sessionId,
      ...(isExecutionIdentityCollectionEnabled(params.cfg)
        ? { internalExecutionIdentityRetry: params.recoveryAttempt > 1 }
        : {}),
      internalExecutionIdentityRecoveryAttempt: params.recoveryAttempt,
      idempotencyKey: recoveryRunId,
      deliver:
        Boolean(deliveryContext) &&
        params.entry.restartRecoverySourceReplyDeliveryMode !== "message_tool_only",
      lane: params.lane ?? CommandLane.RestartRecovery,
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
    // The resend is one ordinary mailbox input. Its reservation id derives from
    // the durable attempt, so a foreground claim can order the same input first;
    // a joined input belongs to its creator and is never retired here.
    if (!controllerInput) {
      const resendSource = withPluginRuntimeGatewayContextResolver(
        getGatewayContextResolver(params.gatewayRuntime),
        () =>
          reserveOrJoinSessionControllerSource(dispatchSessionKey, {
            reservationId: inputReservationId,
            protocolRunId: recoveryRunId,
            sourceSessionId: params.entry.sessionId,
            policy: { mode: "followup" },
            target: captureSessionTarget({
              storeScope: params.storePath,
              sessionKey: dispatchSessionKey,
              aliases: [params.sessionKey],
              agentId: params.agentId,
              incarnation: params.entry.sessionId,
            }),
          }),
      );
      controllerInput = resendSource.input;
      ownedInput = resendSource.created ? resendSource.input : undefined;
    }
    dispatchStarted = true;
    let dispatchSettled = false;
    let stopTyping: (() => void) | undefined;
    const recoverySourceTarget = sourceRunId
      ? { ...target, sessionId: params.entry.sessionId, sourceRunId, recoveryRunId }
      : undefined;
    const dispatchOutcome = await dispatchRestartRecoveryUntilStarted({
      // Preserve own-session admission without granting broader operator scopes.
      agentParams: bindInProcessSessionRun(agentParams, {
        sessionKey: dispatchSessionKey,
        sessionId: params.entry.sessionId,
        lifecycleRevision: params.entry.lifecycleRevision ?? null,
        runId: recoveryRunId,
      }),
      controllerInput,
      gatewayRuntime: params.gatewayRuntime,
      restartRecoveryRequesterTarget: params.entry.restartRecoveryRequesterSource
        ? recoverySourceTarget
        : undefined,
      restartRecoveryOperatorTarget: params.entry.restartRecoveryOperatorSource
        ? recoverySourceTarget
        : undefined,
      assertAdmissionCurrent: () => {
        if (params.shouldContinue?.() === false || !taskRemainsOwed()) {
          throw new Error("Restart recovery admission is no longer current.");
        }
      },
      executionSource: params.executionSource,
      prepareDispatchCurrent: () =>
        runWithAgentToolSourceExecutionScope(params.completionSource, async () => {
          params.completionSource?.();
        }),
      onSettled: () => {
        onDispatchSettled();
        dispatchSettled = true;
        stopTyping?.();
        deliveryCurrent?.release();
        retainDeliveryCurrent = false;
      },
    });
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
    let terminalStatus = normalizeRestartRecoveryTerminalStatus(dispatchResult);
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
    if (
      !(await settleAcceptedRestartRecovery({
        ...settlementTarget,
        terminalStatus,
      }))
    ) {
      throw new Error(`restart recovery admission changed before settlement: ${params.sessionKey}`);
    }
    if (params.shouldContinue?.() === false) {
      return "skipped";
    }
    const resumeResult = terminalStatus ? "settled" : "started";
    if (resumeResult === "started" && agentParams.deliver && deliveryContext && taskRemainsOwed()) {
      deliveryCurrent = await prepareRestartRecoveryDeliveryCurrent({
        ...target,
        storePath: requesterStorePath,
        sessionKey: dispatchSessionKey,
        sessionId: params.entry.sessionId,
        recoveryRunId,
        lifecycleGeneration,
        deliveryContext,
        cfg: params.cfg,
        shouldContinue: params.shouldContinue,
      }).catch((error: unknown) => {
        log.warn(
          `failed to prepare restart recovery notice ${params.sessionKey}: ${String(error)}`,
        );
        return undefined;
      });
      if (deliveryCurrent) {
        const isDeliveryCurrent = deliveryCurrent.isCurrent;
        if (!dispatchSettled) {
          stopTyping = params.gatewayRuntime.startRecoveryTyping?.({
            ...deliveryContext,
            agentId: params.agentId,
            runId: recoveryRunId,
            isCurrent: (cfg) => !dispatchSettled && taskRemainsOwed() && isDeliveryCurrent(cfg),
          });
          retainDeliveryCurrent = stopTyping !== undefined;
        }
        await announceRestartRecoveryResumption({
          ...target,
          isCurrent: (cfg) => !dispatchSettled && taskRemainsOwed() && isDeliveryCurrent(cfg),
          sessionKey: dispatchSessionKey,
          sessionId: params.entry.sessionId,
          recoveryRunId,
          lifecycleGeneration,
          deliveryContext,
          cfg: params.cfg,
          shouldContinue: () =>
            !dispatchSettled && taskRemainsOwed() && params.shouldContinue?.() !== false,
          gatewayRuntime: params.gatewayRuntime,
        });
      }
    }
    log.info(
      `${resumeResult} interrupted main session: ${params.sessionKey}${
        sanitizedPendingText ? " (with pending payload)" : ""
      }`,
    );
    return resumeResult;
  } catch (error) {
    const explicitlyRejected = error instanceof GatewayClientRequestError && !dispatchAccepted;
    if (
      dispatchAccepted &&
      !executionStarted &&
      (!preStartAbortAttempted || preStartAbortConfirmed) &&
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
      if (
        dispatchStarted &&
        (!explicitlyRejected || controllerInput?.abortSignal.aborted) &&
        params.shouldContinue?.() !== false
      ) {
        const terminalStatus = await probeRestartRecoveryTerminalStatus(
          recoveryRunId,
          params.gatewayRuntime,
        );
        // Stop can revoke operator admission before acceptance. Reconcile its
        // recorded cancellation without treating other authority rejections as accepted work.
        if (
          terminalStatus &&
          (!explicitlyRejected || terminalStatus === "cancelled") &&
          params.shouldContinue?.() !== false
        ) {
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
    let rollback: Awaited<ReturnType<typeof rollbackReservation>>;
    if (reservation) {
      const rollbackKind =
        dispatchStarted && !explicitlyRejected ? "abandon_reservation" : "cancel_reservation";
      rollback = await rollbackReservation(rollbackKind).catch((rollbackError: unknown) => {
        log.warn(
          `failed to roll back interrupted main session recovery attempt ${params.sessionKey}: ${String(rollbackError)}`,
        );
        return undefined;
      });
    }
    if (params.shouldContinue?.() === false) {
      return "skipped";
    }
    if (
      rollback?.entry?.sessionId === params.entry.sessionId &&
      hasRestartRecoveryTerminalRun(rollback.entry, recoveryRunId)
    ) {
      // Stop or an interrupt cancelled the resend before it ran; the run recorded that outcome.
      log.info(`stopped interrupted main session resend before execution: ${params.sessionKey}`);
      return "settled";
    }
    const rejected = await settleRejectedRestartRecovery({
      ...params,
      ...target,
      error,
      dispatchAccepted,
      rollback,
    });
    if (rejected) {
      return rejected;
    }
    log.warn(
      `failed to resume interrupted main session ${params.sessionKey}: ${error instanceof Error ? formatErrorStackWithMessage(error) : String(error)}`,
    );
    return "failed";
  } finally {
    if (!retainDeliveryCurrent) {
      deliveryCurrent?.release();
    }
    // Finish the settlement attempt before releasing our unadopted input.
    // A failed write leaves durable recovery facts for their existing owner.
    if (ownedInput && !ownedInput.custody.rpcAdopted) {
      retireSessionControllerInput(ownedInput);
    }
  }
}
