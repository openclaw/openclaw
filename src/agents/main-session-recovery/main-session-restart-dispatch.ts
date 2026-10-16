import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/index.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import { sanitizePendingFinalDeliveryText } from "../../auto-reply/reply/pending-final-delivery-state.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntryCurrentFacts } from "../../config/sessions/session-entry-current.types.js";
import { withSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { preparePhysicalSessionStorePath } from "../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { CommandLane } from "../../process/lanes.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { getOwedHarnessCompletionTask } from "../agent-harness-completion-recovery.js";
import { runWithAgentToolSourceExecutionScope } from "../agent-tool-source-execution-guard.js";
import { RESTART_RECOVERY_INTERRUPTION_NOTE } from "../restart-recovery-prompt.js";
import { listSubagentRunsForRequester } from "../subagents/registry/subagent-registry-read.js";
import {
  buildSubagentRestartRecoveryRoster,
  SUBAGENT_RESTART_RECOVERY_INSTRUCTION,
} from "../subagents/subagent-restart-recovery-prompt.js";
import { TOOL_FAILURE_INSTRUCTION } from "../tool-outcome-instructions.js";
import {
  runWithMainSessionRecoveryAdmission,
  type MainSessionRecoveryAdmission,
} from "./main-session-recovery-admission.js";
import { repairMainSessionRecoveryMutation } from "./main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import type {
  MainSessionRecoveryObservation,
  MainSessionRecoveryReservation,
} from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import {
  rollbackRestartRecoveryReservation,
  scheduleRestartRecoveryReservationRollback,
  settleAcceptedRestartRecovery,
} from "./main-session-restart-dispatch-settlement.js";
import {
  dispatchRestartRecoveryUntilStarted,
  normalizeRestartRecoveryTerminalStatus,
  probeRestartRecoveryTerminalStatus,
} from "./main-session-restart-dispatch-start.js";
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
} from "./main-session-restart-recovery-shared.js";

const RESTART_RECOVERY_RESUME_MESSAGE = formatSystemTurnPrompt(
  `${RESTART_RECOVERY_INTERRUPTION_NOTE} The restart did not cancel the user's task. ` +
    "Continue from the existing transcript: check the current state, recover interrupted work, " +
    "and finish the task without asking the user to repeat the request. " +
    `${SUBAGENT_RESTART_RECOVERY_INSTRUCTION} ${TOOL_FAILURE_INSTRUCTION}`,
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
  const sanitizedPendingText = sanitizePendingFinalDeliveryText(pendingFinalDeliveryText);
  const instructions = forceRestartSafeTools
    ? `${RESTART_RECOVERY_RESUME_MESSAGE}\n\n${RESTART_SAFE_TOOLS_NOTICE}`
    : RESTART_RECOVERY_RESUME_MESSAGE;
  const base = childRecoveryRoster ? `${instructions}\n\n${childRecoveryRoster}` : instructions;
  return sanitizedPendingText
    ? `${base}\n\nNote: The interrupted final reply was captured: "${sanitizedPendingText}"`
    : base;
}

type MainSessionResumeResult = "started" | "settled" | "skipped" | "failed";

type ResumeMainSessionParams = {
  agentId: string;
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  observation: MainSessionRecoveryObservation;
  completionSource?: SessionSourceAssertion;
  recoveryAttempt: number;
  storePath: string;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
  recoveryAdmission?: MainSessionRecoveryAdmission;
  signal?: AbortSignal;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
};

export async function resumeMainSession(
  params: ResumeMainSessionParams,
): Promise<MainSessionResumeResult> {
  const source = captureSessionEntryMetadataRead(params, () => {});
  const matchesRequester = (current: SessionEntryCurrentFacts | undefined) =>
    current?.sessionId === params.entry.sessionId &&
    current.lifecycleRevision === params.entry.lifecycleRevision;
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  using _ = { [Symbol.dispose]: () => retained?.release() };
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
  const isCurrent = () => {
    return source ? matchesRequester(source.readCurrent()) : retained?.isCurrent() === true;
  };
  const result = await runWithMainSessionRecoveryAdmission({
    ...params,
    sessionId: params.entry.sessionId,
    admission: params.recoveryAdmission,
    isCurrent,
    run: (recoveryAdmission) =>
      resumeMainSessionWithinAdmission({
        ...params,
        recoveryAdmission,
        shouldContinue: recoveryAdmission.shouldContinue,
      }),
  });
  return result ?? "skipped";
}

async function resumeMainSessionWithinAdmission(
  params: ResumeMainSessionParams & { recoveryAdmission: MainSessionRecoveryAdmission },
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
    claimedRunId && claimedRunId !== sourceRunId && !claimedRunWasAdmittedBeforeRestart
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
    lifecycleGeneration,
    sessionKeys: Array.from(new Set([dispatchSessionKey, params.sessionKey])),
    shouldContinue: params.shouldContinue,
  };
  let reservation: MainSessionRecoveryReservation | undefined;
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
      internalRuntimeHandoffId: params.recoveryAdmission.handoffId,
      ...(isExecutionIdentityCollectionEnabled(params.cfg)
        ? { internalExecutionIdentityRetry: params.recoveryAttempt > 1 }
        : {}),
      internalExecutionIdentityRecoveryAttempt: params.recoveryAttempt,
      idempotencyKey: recoveryRunId,
      deliver:
        Boolean(deliveryContext) &&
        params.entry.restartRecoverySourceReplyDeliveryMode !== "message_tool_only",
      lane: CommandLane.Background,
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
    if (!params.recoveryAdmission.beginDispatch()) {
      await rollbackReservation("cancel_reservation");
      return "skipped";
    }
    dispatchStarted = true;
    let dispatchSettled = false;
    let stopTyping: (() => void) | undefined;
    const dispatchOutcome = await dispatchRestartRecoveryUntilStarted({
      agentParams,
      gatewayRuntime: params.gatewayRuntime,
      ...(sourceRunId && params.entry.restartRecoveryRequesterSource
        ? {
            restartRecoveryRequesterTarget: {
              ...target,
              sessionId: params.entry.sessionId,
              sourceRunId,
              recoveryRunId,
            },
          }
        : {}),
      ...(sourceRunId && params.entry.restartRecoveryOperatorSource
        ? {
            restartRecoveryOperatorTarget: {
              ...target,
              sessionId: params.entry.sessionId,
              sourceRunId,
              recoveryRunId,
            },
          }
        : {}),
      assertAdmissionCurrent: () => {
        if (params.shouldContinue?.() === false || !taskRemainsOwed()) {
          throw new Error("Restart recovery admission is no longer current.");
        }
      },
      prepareDispatchCurrent: () =>
        runWithAgentToolSourceExecutionScope(params.completionSource, async () => {
          params.completionSource?.();
        }),
      onSettled: () => {
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
    if (!retainDeliveryCurrent) {
      deliveryCurrent?.release();
    }
  }
}
