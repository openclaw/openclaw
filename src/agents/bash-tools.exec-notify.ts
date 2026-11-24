/** Owns captured destinations and cancellation for background exec completion notifications. */
import { enqueueBatchedSessionEventForHost as enqueueSessionEvent } from "../auto-reply/reply/session-event-batch.js";
import { captureSessionEventTargetForHost as captureSessionEventTarget } from "../auto-reply/reply/session-event-handoff.js";
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
import { isOneShotRunSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import {
  listFinishedSessions,
  listRunningSessions,
  processSessionInstanceId,
  recordNotifyOnExitRemoval,
  type ProcessSession,
} from "./bash-process-registry.js";
import {
  appendExecTimeoutRetryGuidance,
  hasExitWake,
  renderExecExitLabel,
  renderExecOutputFile,
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
  const oneShot = subagentSession || isOneShotRunSessionKey(session.sessionKey);
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

/** A cron run executor resumes its yielded turn in place, keyed by the run's chat. */
type ExecYieldResume = { awaited: Set<ProcessSession>; exits: string[]; changed?: () => void };
const execYieldResumes = new Map<string, ExecYieldResume>();

/** A chat is its agent plus session key; a raw key such as `global` is shared across agents. */
type ExecChat = { agentId: string; sessionKey: string };
// Completion admission can outlive process retention and its start-time routing fields.
const pendingExitWakes = new Set<ExecChat>();
const execChatKey = (chat: ExecChat) => `${chat.agentId}\0${chat.sessionKey}`;
const processChat = (session: ProcessSession) =>
  session.sessionKey && session.agentId
    ? execChatKey({ agentId: session.agentId, sessionKey: session.sessionKey })
    : undefined;

/** Running commands this chat started, from any of its runs. */
export function listChatRunningSessions(chat: ExecChat): ProcessSession[] {
  const key = execChatKey(chat);
  return listRunningSessions().filter((session) => processChat(session) === key);
}

/**
 * Wake-armed running commands of this chat; each one's deadline bounds a yield on it. The chat
 * owns its commands, so a later run awaits commands an earlier run started.
 */
export function listYieldAwaitableExecs(chat: ExecChat | undefined): ProcessSession[] {
  if (!chat?.sessionKey) {
    return [];
  }
  return listChatRunningSessions(chat).filter(
    (session) => !session.cancellationRequested && hasExitWake(session),
  );
}

/** The notification owner keeps a wake alive through finalization and receipt settlement. */
export function hasExecYieldWake(chat: ExecChat): boolean {
  if (listYieldAwaitableExecs(chat).length > 0) {
    return true;
  }
  for (const wake of pendingExitWakes) {
    if (wake.agentId === chat.agentId && wake.sessionKey === chat.sessionKey) {
      return true;
    }
  }
  const key = execChatKey(chat);
  return listFinishedSessions().some(
    (session) => session.finalizing && session.resumesYieldedRun && processChat(session) === key,
  );
}

/** An accepted sessions_yield awaits these commands: each exit resumes the yielded chat. */
export function awaitExecsForYield(sessions: readonly ProcessSession[]): void {
  for (const session of sessions) {
    session.resumesYieldedRun = true;
    const chat = processChat(session);
    if (chat) {
      execYieldResumes.get(chat)?.awaited.add(session);
    }
  }
}

/**
 * Cron run executor: own resumption of this chat's yielded turns until disposed. `next` resolves
 * the wake text of every awaited exit so far, or undefined once nothing awaited remains.
 */
export function openExecYieldResume(chat: ExecChat) {
  const key = execChatKey(chat);
  const state: ExecYieldResume = { awaited: new Set(), exits: [] };
  execYieldResumes.set(key, state);
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
      if (execYieldResumes.get(key) === state) {
        execYieldResumes.delete(key);
      }
    },
  };
}

export async function maybeNotifyOnExit(
  session: ProcessSession,
  status: "completed" | "failed",
  subagentSession: boolean,
) {
  const chat = processChat(session);
  const resume = chat ? execYieldResumes.get(chat) : undefined;
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
  // The retained tail (last 2,000 chars) lets the woken turn act; the output file has the rest.
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
  const file = session.outputFile;
  const summary = !output
    ? `${header} with no output.`
    : session.totalOutputChars <= tail.length
      ? `${header}:\n${output}`
      : file
        ? `${header}, last ${tail.length} of ${session.totalOutputChars} output chars:\n${output}\n${renderExecOutputFile(file)}`
        : // Sandbox, node and durable commands keep no host output file.
          `${header}, last ${tail.length} of ${session.totalOutputChars} output chars (${
            session.totalOutputChars > session.aggregated.length
              ? `process log keeps the last ${session.aggregated.length}; earlier output was discarded`
              : "process log has the rest"
          }):\n${output}`;
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
      // Admission resolves the chat by key: a deleted chat refuses the wake.
      const receipt = enqueueExecExitNotification(
        eventText,
        session.notifySessionTarget,
        processSessionInstanceId(session),
        { ...eventOptions, sourceRunId: session.startedByRunId },
      );
      recordNotifyOnExitRemoval(session, receipt.cancel);
      const wake = { agentId, sessionKey: eventSessionKey };
      pendingExitWakes.add(wake);
      void receipt.settled.then((outcome) => {
        pendingExitWakes.delete(wake);
        if (outcome.status === "failed") {
          logWarn(
            `exec: completion delivery failed (${outcome.error}); inspect the process result.`,
          );
        }
      });
    } catch (error) {
      logWarn(
        `exec: completion was not admitted (${formatErrorMessage(error)}); inspect the result with process log.`,
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
