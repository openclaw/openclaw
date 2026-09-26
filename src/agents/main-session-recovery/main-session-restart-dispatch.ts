import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/index.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import { sanitizePendingFinalDeliveryText } from "../../auto-reply/reply/pending-final-delivery-state.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { resolveRestartRecoveryChannelAuthority } from "../../config/sessions/restart-recovery-state.js";
import {
  applySessionEntryReplacements,
  loadExactSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isTrustedMessageActionTurnIngress } from "../../gateway/message-action-turn-capability.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { CommandLane } from "../../process/lanes.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { getOwedHarnessCompletionTask } from "../agent-harness-completion-recovery.js";
import { TOOL_FAILURE_INSTRUCTION } from "../tool-outcome-instructions.js";
import {
  runWithMainSessionRecoveryAdmission,
  type MainSessionRecoveryAdmission,
} from "./main-session-recovery-admission.js";
import {
  repairMainSessionRecoveryMutation,
  retryMainSessionRecoveryMutation,
  scheduleMainSessionRecoveryMutation,
} from "./main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import {
  isMainSessionRecoveryPending,
  type MainSessionRecoveryObservation,
  type MainSessionRecoveryReservation,
} from "./main-session-recovery-state.js";
import {
  commitMainSessionRecovery,
  type MainSessionRecoveryStoreTarget,
} from "./main-session-recovery-store.js";
import { dispatchRestartRecoveryWithinCapacity } from "./main-session-restart-dispatch-capacity.js";
import { settleAcceptedRestartRecovery } from "./main-session-restart-dispatch-settlement.js";
import {
  normalizeRestartRecoveryTerminalStatus,
  probeRestartRecoveryTerminalStatus,
} from "./main-session-restart-dispatch-start.js";
import {
  announceRestartRecoveryResumption,
  isRestartRecoveryDeliveryCurrent,
  resolveRestartRecoveryDeliveryContext,
} from "./main-session-restart-recovery-delivery.js";
import { mainSessionRecoveryLog as log } from "./main-session-restart-recovery-shared.js";

const RESTART_RECOVERY_RESUME_MESSAGE = formatSystemTurnPrompt(
  "Your previous turn was interrupted by a gateway restart while " +
    "OpenClaw was waiting on tool/model work. The restart did not cancel the user's task. " +
    "Continue from the existing transcript: check the current state, recover interrupted work, " +
    "and finish the task without asking the user to repeat the request. Interrupted subagents " +
    "are not automatically relaunched. Inspect their saved results and current status; " +
    "continue a retained child session or start a replacement when needed, after confirming " +
    "the previous execution has stopped. Treat a tool result " +
    "marked interrupted or missing as having an unknown outcome; verify what happened before " +
    `repeating an action. ${TOOL_FAILURE_INSTRUCTION}`,
);

const RESTART_SAFE_TOOLS_NOTICE =
  "For this turn only, the tool surface has been narrowed to replay-safe tools as a " +
  "recovery precaution. Use the tools that are available to report status or continue " +
  "read-only work; the full tool surface restores on the next user turn.";

export function hasRestartRecoveryMessageActionAuthority(entry: SessionEntry): boolean {
  const authority = resolveRestartRecoveryChannelAuthority(entry);
  // Keep the pre-dispatch gate identical to recovered capability minting.
  return (
    authority !== undefined && isTrustedMessageActionTurnIngress(authority.deliveryContext.channel)
  );
}

/** Internal continuations never inherit channel authority; every other message-tool recovery must. */
export function requiresRestartRecoveryMessageActionAuthority(entry: SessionEntry): boolean {
  return (
    entry.restartRecoverySourceReplyDeliveryMode === "message_tool_only" &&
    entry.restartRecoverySourceIngress !== "internal"
  );
}

function buildResumeMessage(
  pendingFinalDeliveryText?: string | null,
  forceRestartSafeTools?: boolean,
): string {
  const sanitizedPendingText =
    typeof pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(pendingFinalDeliveryText)
      : "";
  const base = forceRestartSafeTools
    ? `${RESTART_RECOVERY_RESUME_MESSAGE}\n\n${RESTART_SAFE_TOOLS_NOTICE}`
    : RESTART_RECOVERY_RESUME_MESSAGE;
  if (sanitizedPendingText) {
    return `${base}\n\nNote: The interrupted final reply was captured: "${sanitizedPendingText}"`;
  }
  return base;
}

type MainSessionResumeResult = "started" | "settled" | "skipped" | "failed";

function readInterruptedRunId(entry: SessionEntry): string | undefined {
  const runs = entry.restartRecoveryRuns;
  return runs?.length === 1
    ? runs[0]?.runId
    : !runs?.length
      ? normalizeOptionalString(entry.lifecycleRunId)
      : undefined;
}

async function rollbackRestartRecoveryReservation(
  params: MainSessionRecoveryStoreTarget & {
    kind: "abandon_reservation" | "cancel_reservation";
    reservation: MainSessionRecoveryReservation;
  },
) {
  return await retryMainSessionRecoveryMutation(async () =>
    commitMainSessionRecovery({
      command: { kind: params.kind, reservation: params.reservation },
      requireWriteSuccess: true,
      target: params,
    }),
  );
}

function scheduleRestartRecoveryReservationRollback(
  params: Parameters<typeof rollbackRestartRecoveryReservation>[0],
): void {
  // Keep the exact reservation token alive after transient store outages.
  // A Gateway restart safely retires the timer and its stale-generation slot.
  scheduleMainSessionRecoveryMutation({
    mutation: () => rollbackRestartRecoveryReservation(params),
    onError: (error) => {
      log.warn(
        `failed delayed restart recovery reservation rollback ${params.sessionKey}: ${String(error)}`,
      );
    },
    onSuccess: ({ entry, sessionKey }) => {
      if (
        entry?.sessionId === params.reservation.sessionId &&
        sessionKey &&
        isMainSessionRecoveryPending(entry, sessionKey)
      ) {
        scheduleMainSessionRecoveryPendingTarget({
          agentId: params.agentId,
          sessionId: entry.sessionId,
          sessionKey,
          storePath: params.storePath,
        });
      }
    },
  });
}

type ResumeMainSessionParams = {
  agentId: string;
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  observation: MainSessionRecoveryObservation;
  recoveryAttempt: number;
  storePath: string;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
  recoveryAdmission?: MainSessionRecoveryAdmission;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
  recoveryCapacity?: Parameters<typeof dispatchRestartRecoveryWithinCapacity>[0]["capacity"];
};

export async function resumeMainSession(
  params: ResumeMainSessionParams,
): Promise<MainSessionResumeResult> {
  return (
    (await runWithMainSessionRecoveryAdmission({
      ...params,
      sessionId: params.entry.sessionId,
      admission: params.recoveryAdmission,
      isCurrent: () =>
        loadExactSessionEntry({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          readConsistency: "latest",
        })?.entry.sessionId === params.entry.sessionId,
      run: (recoveryAdmission) =>
        resumeMainSessionWithinAdmission({
          ...params,
          recoveryAdmission,
          shouldContinue: recoveryAdmission.shouldContinue,
        }),
    })) ?? "skipped"
  );
}

async function resumeMainSessionWithinAdmission(
  params: ResumeMainSessionParams & { recoveryAdmission: MainSessionRecoveryAdmission },
): Promise<MainSessionResumeResult> {
  if (params.shouldContinue?.() === false) {
    return "skipped";
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
    // Persist one stable RPC id before dispatch. A transport rejection is
    // ambiguous; retries must reuse this id so accepted work cannot duplicate.
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
          entry.status !== "running" ||
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
        current.status === "running" &&
        current.abortedLastRun === true &&
        !current.mainRestartRecovery?.reservation &&
        !current.mainRestartRecovery?.tombstone
        ? "failed"
        : "skipped";
    }
    const agentParams: AgentRunRequest = {
      agentId: params.agentId,
      message: buildResumeMessage(sanitizedPendingText, params.forceRestartSafeTools),
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
    dispatchStarted = true;
    let dispatchSettled = false;
    let stopTyping: (() => void) | undefined;
    const dispatchOutcome = await dispatchRestartRecoveryWithinCapacity({
      agentParams,
      capacity: params.recoveryCapacity,
      beginDispatch: params.recoveryAdmission.beginDispatch,
      gatewayRuntime: params.gatewayRuntime,
      onSettled: () => {
        dispatchSettled = true;
        stopTyping?.();
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
              shouldContinue: params.shouldContinue,
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
        shouldContinue: () =>
          !dispatchSettled && taskRemainsOwed() && params.shouldContinue?.() !== false,
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
  }
}
