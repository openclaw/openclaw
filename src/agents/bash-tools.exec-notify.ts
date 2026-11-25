/** Owns captured destinations and cancellation for background exec completion notifications. */
import { enqueueBatchedSessionEventForHost as enqueueSessionEvent } from "../auto-reply/reply/session-event-batch.js";
import type {
  SessionEventOptions,
  SessionEventOutcome,
  SessionEventTarget,
} from "../auto-reply/reply/session-event-contract.js";
import { captureSessionEventTargetForHost as captureSessionEventTarget } from "../auto-reply/reply/session-event-handoff.js";
import { readSessionEventTargetOperatorAuthority } from "../auto-reply/reply/session-event-target.js";
import { runWithoutSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import type { OperatorAdmissionContext } from "../gateway/operator-admission.js";
import { captureQueuedOperatorRecoverySource } from "../gateway/operator-run-recovery-source.js";
import { restoreGatewayQueuedOperatorRecovery } from "../gateway/operator-run-recovery.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveEventSessionKeyForPolicy } from "../infra/event-session-routing.js";
import { readExecRequestOwners, withExecRequestOwners } from "../infra/exec-request-context.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import {
  enqueueSystemEventWithReceipt,
  SystemEventQueueFullError,
} from "../infra/system-events.js";
import { logWarn } from "../logger.js";
import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import { isGatewayRestartDraining } from "../process/gateway-work-admission.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { chatRef, type ChatRef } from "../sessions/chat-ref.js";
import { owe, readPendingOwed, withhold, type Owed } from "../sessions/owed.js";
import { isOneShotRunSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { resolvePendingInputEndCause } from "../sessions/user-turn-transcript-processing.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
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
        `exec: automatic completion has no destination (${sessionKind(session.sessionKey)} session; ${formatErrorMessage(error)}); use process poll.`,
      );
    },
  );
}

/** A cron run executor resumes its yielded turn in place, keyed by the run's chat. */
type ExecYieldResume = { awaited: Set<ProcessSession>; exits: string[]; changed?: () => void };
const execYieldResumes = new Map<string, ExecYieldResume>();

/** A chat is its agent plus session key; a raw key such as `global` is shared across agents. */
type ExecChat = { agentId: string; sessionKey: string };
const execChatKey = (chat: ExecChat) => `${chat.agentId}\0${chat.sessionKey}`;
/** Failure logs name the session kind, never the session key or id. */
const sessionKind = (sessionKey: string | undefined) =>
  isIncognitoSessionKey(sessionKey) ? "incognito" : "normal";
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

/** The notification owner keeps a wake alive through finalization; the owed row covers the rest. */
export function hasExecYieldWake(chat: ExecChat): boolean {
  if (listYieldAwaitableExecs(chat).length > 0) {
    return true;
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

/** The requester whose turn started the command, as a saved source; none when unavailable. */
export function captureExecRequesterSource(target: SessionEventTarget | undefined) {
  const source = captureQueuedOperatorRecoverySource(
    target && readSessionEventTargetOperatorAuthority(target),
  );
  return source?.kind === "unavailable" ? undefined : source;
}

/**
 * Admits a saved requester again and captures their chat as them, so the wake runs as them. The
 * caller releases the admission once the wake and its retry settle (`wakeOwedExec` resolves).
 */
export async function captureOwedRequesterTarget(
  to: ChatRef,
  source: unknown,
  context: OperatorAdmissionContext | undefined,
  assertCurrent: () => void,
): Promise<{ target: SessionEventTarget; release: () => void }> {
  if (!context) {
    throw new GatewayOperatorAccessUnavailableError();
  }
  const admitted = await restoreGatewayQueuedOperatorRecovery({
    agentId: to.agentId,
    context,
    source,
    assertCurrent,
  });
  try {
    const target = await captureSessionEventTarget(to.agentId, to.sessionKey, {
      operatorAuthority: admitted.authority,
      assertCurrent,
    });
    return { target, release: admitted.release };
  } catch (error) {
    admitted.release();
    throw error;
  }
}

/**
 * The one exec wake: it delivers a stored exec result through session-event admission. A live
 * wake passes the producer's captured target; restart recovery passes none, so admission
 * captures the chat's current target. Its settlement reads the stored row; `retries` stored
 * wakes follow a failed one. Resolves once the last attempt settles, so a caller holding the
 * target's admission keeps it for the retry too.
 */
export function wakeOwedExec(
  owed: Owed,
  options: Omit<SessionEventOptions, "agentId" | "sessionKey" | "source"> = {},
  onWake?: (cancel: () => boolean) => void,
  retries = 0,
): Promise<void> {
  const wakeAgain =
    retries > 0 ? (stored: Owed) => wakeOwedExec(stored, options, onWake, retries - 1) : undefined;
  let receipt: ReturnType<typeof enqueueSessionEvent>;
  try {
    receipt = enqueueSessionEvent(owed.text, {
      ...options,
      agentId: owed.to.agentId,
      sessionKey: owed.to.sessionKey,
      source: "exec",
      contextKey: owed.id,
      sourceTurnId: owed.id,
    });
  } catch (error) {
    // A refused enqueue (for example a full wake pool) settles like a wake that never started.
    const failed = { status: "failed", executionStarted: false, delivered: false } as const;
    return settleOwedExecWake(owed, { ...failed, error: formatErrorMessage(error) }, wakeAgain);
  }
  onWake?.(receipt.cancel);
  return receipt.settled.then((outcome) => settleOwedExecWake(owed, outcome, wakeAgain));
}

/**
 * Settles a wake by the stored row, not by its outcome; a row its turn appended or a fold
 * consumed needs nothing. A completed wake that left the row pending answered it inside a shared
 * turn's input (its fold failed); the row is hidden. A failed wake with a retry left wakes the
 * chat again from the stored row, whose text a fold may have joined. A stop, or a failure with
 * no retry left, withholds the result with that cause. Restart drains leave the row owed for
 * restart recovery.
 */
async function settleOwedExecWake(
  owed: Owed,
  outcome: SessionEventOutcome,
  wakeAgain?: (stored: Owed) => Promise<void>,
) {
  if (outcome.status === "failed") {
    logWarn(
      `exec: completion delivery failed (${sessionKind(owed.to.sessionKey)} session; ${outcome.error}); inspect the process result.`,
    );
  }
  try {
    const stored = isGatewayRestartDraining() ? undefined : await readPendingOwed(owed);
    if (!stored) {
      return;
    }
    if (outcome.status === "completed") {
      await withhold(owed, "failed", "interrupted");
    } else if (outcome.status === "failed" && wakeAgain) {
      await wakeAgain(stored);
    } else {
      await withhold(owed, outcome.status === "cancelled" ? "user-stop" : "failed");
    }
  } catch (error) {
    logWarn(
      `exec: completion ${owed.id} stays owed (${sessionKind(owed.to.sessionKey)} session; ${formatErrorMessage(error)}).`,
    );
  }
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
    const target = session.notifySessionTarget;
    if (!agentId || !target?.storePath) {
      logWarn(
        `exec: completion ${session.id} has no admitted session destination (${sessionKind(eventSessionKey)} session); inspect its process result.`,
      );
      return;
    }
    try {
      // A restored process carries its saved requester; a live one has it on the captured target.
      const operatorSource = session.operatorSource ?? captureExecRequesterSource(target);
      // The result is stored before any delivery: a Goal check or restart sees it from here on.
      const owed: Owed = {
        id: `exec:${processSessionInstanceId(session)}`,
        to: chatRef({ agentId, storePath: target.storePath, sessionKey: eventSessionKey }),
        kind: "exec",
        text: eventText,
        // Restart recovery replays the requester through admission, not the session principal.
        ...(operatorSource ? { originFacts: { operatorSource } } : {}),
      };
      // The completion outlives the turn that started the command, so it stores and wakes under
      // its own session actor and work scope: an incognito turn's actor and signal end with it.
      await runOutsideAsyncWorkScope(() =>
        runWithoutSessionActorStorage(async () => {
          // A store failure must not drop the result: it is delivered live once, without a
          // stored row to retry from or to replay after a restart.
          const stored = await owe(owed).then(
            () => true,
            (error: unknown) => {
              logWarn(
                `exec: completion ${session.id} was not stored (${sessionKind(eventSessionKey)} session; ${formatErrorMessage(error)}); delivering it without restart recovery.`,
              );
              return false;
            },
          );
          let admitted: { target: SessionEventTarget; release: () => void } | undefined;
          if (session.operatorSource) {
            // A restored process wakes as its requester, admitted again now. If their access
            // ended, the stored result stays in the chat with that cause.
            try {
              admitted = await captureOwedRequesterTarget(
                owed.to,
                session.operatorSource,
                getInProcessGatewayRequestContext(),
                () => target.assertCurrent?.(),
              );
            } catch (error) {
              if (!stored) {
                throw error;
              }
              await withhold(owed, resolvePendingInputEndCause(undefined, error) ?? "failed");
              return;
            }
          }
          // Admission resolves the chat by key: a deleted chat refuses the wake. The captured
          // target and request owners carry the requester's authority into the one retry too.
          // The admission is held until the last attempt settles, so the retry keeps it too.
          void wakeOwedExec(
            owed,
            {
              ...eventOptions,
              sourceRunId: session.startedByRunId,
              expectedTarget: admitted?.target ?? target,
            },
            (cancel) => recordNotifyOnExitRemoval(session, cancel),
            stored ? 1 : 0,
          ).finally(() => admitted?.release());
        }),
      );
    } catch (error) {
      logWarn(
        `exec: completion was not admitted (${sessionKind(eventSessionKey)} session; ${formatErrorMessage(error)}); inspect the result with process log.`,
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
    logWarn(
      `exec: completion ${session.id} was not queued (${sessionKind(sessionKey)} session; ${error.message}); use process poll.`,
    );
  }
}
