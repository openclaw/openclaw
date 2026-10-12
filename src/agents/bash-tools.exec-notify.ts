/** Owns captured destinations and cancellation for background exec completion notifications. */
import {
  captureSessionEventTargetForHost as captureSessionEventTarget,
  enqueueSessionEventForHost as enqueueSessionEvent,
} from "../auto-reply/reply/session-event-handoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveEventSessionKeyForPolicy } from "../infra/event-session-routing.js";
import { readExecRequestOwners, withExecRequestOwners } from "../infra/exec-request-context.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEventWithReceipt } from "../infra/system-events.js";
import { logWarn } from "../logger.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { recordNotifyOnExitRemoval, tail, type ProcessSession } from "./bash-process-registry.js";
import {
  appendExecTimeoutRetryGuidance,
  compactNotifyOutput,
  renderExecExitLabel,
} from "./bash-tools.exec-output.js";

const DEFAULT_NOTIFY_TAIL_CHARS = 400;

/** Capture the original session before spawning work that may outlive its turn. */
export function prepareExecExitNotification(
  session: ProcessSession,
  subagentSession: boolean,
): Promise<void> | undefined {
  if (
    !session.notifyOnExit ||
    !session.sessionKey ||
    subagentSession ||
    isSubagentSessionKey(session.sessionKey)
  ) {
    return undefined;
  }
  const targetKey = resolveEventSessionKeyForPolicy(session.sessionKey, session.eventRouting ?? {});
  const owner = session.agentId ?? parseAgentSessionKey(targetKey)?.agentId;
  if (!owner) {
    return undefined;
  }
  return captureSessionEventTarget(owner, targetKey).then(
    (target) => {
      session.notifySessionTarget = target;
    },
    (error: unknown) => {
      logWarn(
        `exec: automatic completion has no destination (${formatErrorMessage(error)}); use process poll.`,
      );
    },
  );
}

export function maybeNotifyOnExit(
  session: ProcessSession,
  status: "completed" | "failed",
  subagentSession: boolean,
) {
  if (
    !session.backgrounded ||
    !session.notifyOnExit ||
    session.requestCancelled ||
    readExecRequestOwners(session)?.some((owner) => owner.signal.aborted) ||
    session.exitNotified ||
    session.terminalPollObserved
  ) {
    return;
  }
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  session.exitNotified = true;
  // Requested stops must not wake another turn to relay leftover output.
  if (session.exitReason === "manual-cancel" && session.finalizationFailed !== true) {
    return;
  }
  const exitLabel = renderExecExitLabel(session);
  const output = compactNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  if (
    status === "completed" &&
    session.exitCode === 0 &&
    !output &&
    session.notifyOnExitEmptySuccess !== true
  ) {
    return;
  }
  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
  const eventText = appendExecTimeoutRetryGuidance(summary, session.exitReason);
  const eventRouting = session.eventRouting ?? {};
  const eventSessionKey = resolveEventSessionKeyForPolicy(sessionKey, eventRouting);
  const eventOptions = withExecRequestOwners(
    {
      sessionKey: eventSessionKey,
      contextKey: `exec:${session.id}`,
      deliveryContext: session.notifyDeliveryContext,
      fromConversationTurn: session.notifyFromConversationTurn,
    },
    readExecRequestOwners(session),
  );
  if (!subagentSession && !isSubagentSessionKey(sessionKey)) {
    const agentId = session.agentId ?? parseAgentSessionKey(eventSessionKey)?.agentId;
    if (!agentId || !session.notifySessionTarget) {
      logWarn(
        `exec: completion ${session.id} has no admitted session destination; inspect its process result.`,
      );
      return;
    }
    try {
      const receipt = enqueueSessionEvent(eventText, {
        ...eventOptions,
        agentId,
        source: "exec",
        expectedTarget: session.notifySessionTarget,
      });
      recordNotifyOnExitRemoval(session, receipt.cancel);
      void receipt.settled.then((outcome) => {
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
  const remove = enqueueSystemEventWithReceipt(
    eventText,
    session.agentId ? withSystemEventOwner(eventOptions, session.agentId) : eventOptions,
    { allowDuplicate: true },
  );
  if (remove) {
    recordNotifyOnExitRemoval(session, remove);
  }
}
