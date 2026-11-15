/** Owns captured destinations and cancellation for background exec completion notifications. */
import { enqueueBatchedSessionEventForHost as enqueueSessionEvent } from "../auto-reply/reply/session-event-batch.js";
import { captureSessionEventTargetForHost as captureSessionEventTarget } from "../auto-reply/reply/session-event-handoff.js";
import {
  hasAgentRunContextExecutionOwner,
  listAgentRunsForSession,
} from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveEventSessionKeyForPolicy } from "../infra/event-session-routing.js";
import { readExecRequestOwners, withExecRequestOwners } from "../infra/exec-request-context.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import {
  enqueueSystemEventWithReceipt,
  SystemEventQueueFullError,
} from "../infra/system-events.js";
import { logWarn } from "../logger.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import {
  listRunningSessions,
  processSessionInstanceId,
  recordNotifyOnExitRemoval,
  type ProcessSession,
} from "./bash-process-registry.js";
import {
  appendExecTimeoutRetryGuidance,
  hasExitWake,
  renderExecExitLabel,
} from "./bash-tools.exec-output.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

function enqueueExecExitNotification(
  text: string,
  target: NonNullable<ProcessSession["notifySessionTarget"]>,
  id: string,
  options: Omit<
    Parameters<typeof enqueueSessionEvent>[1],
    "agentId" | "sessionKey" | "source"
  > = {},
) {
  return enqueueSessionEvent(text, {
    ...options,
    agentId: target.agentId!,
    sessionKey: target.sessionKey!,
    source: "exec",
    contextKey: options.contextKey ?? `exec:${id}`,
    sourceTurnId: `exec:${id}`,
    expectedTarget: target,
  });
}

/** Capture the original session before spawning work that may outlive its turn. */
export function prepareExecExitNotification(
  session: ProcessSession,
  subagentSession: boolean,
  sessionsYieldAvailable: boolean,
): Promise<void> | undefined {
  if (!session.notifyOnExit || !session.sessionKey) {
    return undefined;
  }
  const hiddenSubagent = subagentSession || isSubagentSessionKey(session.sessionKey);
  // A one-shot run ends with its final reply; only a yield awaiting the command resumes it.
  // Without sessions_yield (collectors, filtered tools) a hidden subagent keeps its passive notice.
  if (hiddenSubagent && !sessionsYieldAvailable) {
    return undefined;
  }
  const oneShot = hiddenSubagent || isCronRunSessionKey(session.sessionKey);
  // Ordinary event admission can address the cron run directly, unlike heartbeat drains.
  const targetKey = oneShot
    ? session.sessionKey
    : resolveEventSessionKeyForPolicy(session.sessionKey, session.eventRouting ?? {});
  const owner = session.agentId ?? parseAgentSessionKey(targetKey)?.agentId;
  if (!owner) {
    return undefined;
  }
  return captureSessionEventTarget(owner, targetKey, {
    operatorAuthority: getGatewayToolCallerIdentity()?.operatorAuthority,
    // The completion continues the requester's own command, not a new sender's request.
    retainRequesterOwner: true,
  }).then(
    (target) => {
      if (isCronRunSessionKey(targetKey)) {
        const runs = listAgentRunsForSession({
          sessionKey: targetKey,
          sessionId: target.sessionId,
        });
        // The originating run must survive queue acceptance, not the queued follow-up.
        session.assertExitNotificationAcceptanceCurrent = () => {
          if (!runs.some((run) => hasAgentRunContextExecutionOwner(run.runId))) {
            throw new Error("Originating cron run ended; inspect the result with process log");
          }
        };
      }
      if (oneShot && sessionsYieldAvailable) {
        session.exitWakeAfterYield = true;
      }
      session.notifySessionTarget = target;
    },
    (error: unknown) => {
      // A hidden subagent keeps its passive completion notice without a wake destination.
      if (!hiddenSubagent) {
        session.notifyOnExit = false;
      }
      logWarn(
        `exec: automatic completion has no destination (${formatErrorMessage(error)}); use process poll.`,
      );
    },
  );
}

/** A cron run executor resumes its yielded turn in place, keyed by the run that yielded. */
type ExecYieldResume = { awaited: Set<ProcessSession>; exits: string[]; changed?: () => void };
const execYieldResumes = new Map<string, ExecYieldResume>();

/** Wake-armed running commands this run started; each one's deadline bounds a yield on it. */
export function listYieldAwaitableExecs(runId: string | undefined): ProcessSession[] {
  if (!runId) {
    return [];
  }
  return listRunningSessions().filter(
    (session) =>
      session.originRunId === runId && !session.cancellationRequested && hasExitWake(session),
  );
}

/** An accepted sessions_yield awaits these commands: each exit resumes the yielded run. */
export function awaitExecsForYield(sessions: readonly ProcessSession[]): void {
  for (const session of sessions) {
    session.resumesYieldedRun = true;
    if (session.originRunId) {
      execYieldResumes.get(session.originRunId)?.awaited.add(session);
    }
  }
}

/**
 * Cron run executor: own resumption of this run's yielded turns until disposed. `next` resolves the
 * wake text of every awaited exit so far, or undefined once nothing awaited remains.
 */
export function openExecYieldResume(runId: string) {
  const state: ExecYieldResume = { awaited: new Set(), exits: [] };
  execYieldResumes.set(runId, state);
  return {
    async next(signal?: AbortSignal): Promise<string | undefined> {
      for (;;) {
        if (state.exits.length > 0) {
          return state.exits.splice(0).join("\n\n");
        }
        if (state.awaited.size === 0 || signal?.aborted) {
          return undefined;
        }
        await new Promise<void>((resolve) => {
          state.changed = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
    [Symbol.dispose]() {
      if (execYieldResumes.get(runId) === state) {
        execYieldResumes.delete(runId);
      }
    },
  };
}

export async function maybeNotifyOnExit(
  session: ProcessSession,
  status: "completed" | "failed",
  subagentSession: boolean,
) {
  const resume = session.originRunId ? execYieldResumes.get(session.originRunId) : undefined;
  if (!resume?.awaited.has(session)) {
    return notifyOnExit(session, status, subagentSession);
  }
  try {
    const eventText = prepareExecExitWake(session, status);
    if (eventText) {
      resume.exits.push(eventText);
    }
  } finally {
    // A suppressed exit (Stop, kill) still releases the yielded run.
    resume.awaited.delete(session);
    resume.changed?.();
  }
}

/** Claims the exit once and renders its wake text, or undefined when the exit starts no turn. */
function prepareExecExitWake(
  session: ProcessSession,
  status: "completed" | "failed",
): string | undefined {
  if (session.exitNotified) {
    return undefined;
  }
  if (
    !session.backgrounded ||
    !session.notifyOnExit ||
    session.requestCancelled ||
    readExecRequestOwners(session)?.some((owner) => owner.signal.aborted) ||
    session.terminalPollObserved ||
    !session.sessionKey?.trim()
  ) {
    return undefined;
  }
  session.exitNotified = true;
  // Requested stops must not wake another turn to relay leftover output.
  if (session.exitReason === "manual-cancel" && session.finalizationFailed !== true) {
    return undefined;
  }
  // The retained tail (last 2,000 chars) lets the woken turn act without process log.
  const tail = session.tail;
  const output = tail.trim();
  if (
    status === "completed" &&
    session.exitCode === 0 &&
    !output &&
    session.notifyOnExitEmptySuccess !== true
  ) {
    return undefined;
  }
  const header = `Exec ${status} (${session.id.slice(0, 8)}, ${renderExecExitLabel(session)}, ${
    formatDurationCompact((session.endedAt ?? Date.now()) - session.startedAt) ?? "0s"
  })`;
  const summary = !output
    ? `${header} with no output.`
    : session.totalOutputChars > tail.length
      ? `${header}, last ${tail.length} of ${session.totalOutputChars} output chars (${
          session.totalOutputChars > session.aggregated.length
            ? `process log keeps the last ${session.aggregated.length}; earlier output was discarded`
            : "process log has the rest"
        }):\n${output}`
      : `${header}:\n${output}`;
  return appendExecTimeoutRetryGuidance(summary, session.exitReason);
}

async function notifyOnExit(
  session: ProcessSession,
  status: "completed" | "failed",
  subagentSession: boolean,
) {
  const eventText = prepareExecExitWake(session, status);
  const sessionKey = session.sessionKey?.trim();
  if (!eventText || !sessionKey) {
    return;
  }
  const eventSessionKey =
    session.notifySessionTarget?.sessionKey ??
    resolveEventSessionKeyForPolicy(sessionKey, session.eventRouting);
  const eventOptions = withExecRequestOwners(
    {
      sessionKey: eventSessionKey,
      contextKey: `exec:${session.id}`,
      deliveryContext: session.notifyDeliveryContext,
    },
    readExecRequestOwners(session),
  );
  // A yielded hidden subagent resumes through an ordinary wake turn; otherwise it gets a passive notice.
  if (session.resumesYieldedRun || (!subagentSession && !isSubagentSessionKey(sessionKey))) {
    const agentId = session.agentId ?? parseAgentSessionKey(eventSessionKey)?.agentId;
    if (!agentId || !session.notifySessionTarget) {
      logWarn(
        `exec: completion ${session.id} has no admitted session destination; inspect its process result.`,
      );
      return;
    }
    try {
      const receipt = enqueueExecExitNotification(
        eventText,
        session.notifySessionTarget,
        processSessionInstanceId(session),
        {
          ...eventOptions,
          sourceRunId: session.originRunId,
          assertAcceptanceCurrent: session.assertExitNotificationAcceptanceCurrent,
        },
      );
      recordNotifyOnExitRemoval(session, receipt.cancel);
      void receipt.settled.then(async (outcome) => {
        if (outcome.status === "failed") {
          logWarn(
            `exec: completion delivery failed (${outcome.error}); inspect the process result.`,
          );
        }
      });
    } catch (error) {
      logWarn(
        `exec: completion was not admitted (${formatErrorMessage(error)}); inspect the process result.`,
      );
    }
    return;
  }
  // Subagent results remain available to process poll and the announce owner.
  try {
    const remove = enqueueSystemEventWithReceipt(
      eventText,
      session.agentId ? withSystemEventOwner(eventOptions, session.agentId) : eventOptions,
      { allowDuplicate: true },
    );
    if (remove) {
      recordNotifyOnExitRemoval(session, remove);
    }
  } catch (error) {
    if (!(error instanceof SystemEventQueueFullError)) {
      throw error;
    }
    logWarn(`exec: completion ${session.id} was not queued (${error.message}); use process poll.`);
  }
}
