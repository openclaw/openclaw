import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  resolveEventSessionKeyForPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../infra/event-session-routing.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEventWithReceipt } from "../infra/system-events.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import type { ProcessSession } from "./bash-process-registry.js";
import { recordNotifyOnExitRemoval, tail } from "./bash-process-registry.js";
import { isExecCompletionRouteCurrent } from "./bash-tools.exec-completion-route.js";
import { appendExecTimeoutRetryGuidance, renderExecExitLabel } from "./bash-tools.exec-output.js";

const DEFAULT_NOTIFY_TAIL_CHARS = 400;
const DEFAULT_NOTIFY_SNIPPET_CHARS = 180;

/** Normalizes notification snippets to a compact single-line form. */
export function normalizeNotifyOutput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function compactNotifyOutput(value: string, maxChars = DEFAULT_NOTIFY_SNIPPET_CHARS) {
  const normalized = normalizeNotifyOutput(value);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const safe = Math.max(1, maxChars - 1);
  return `${truncateUtf16Safe(normalized, safe)}…`;
}

export function maybeNotifyOnExecExit(
  session: ProcessSession,
  status: "completed" | "failed",
): void {
  if (
    !session.backgrounded ||
    !session.notifyOnExit ||
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
  const expectedGeneration = session.eventRouting?.expectedSessionGeneration;
  if (
    !isExecCompletionRouteCurrent({
      sessionKey,
      agentId: session.agentId,
      eventRouting: session.eventRouting,
    })
  ) {
    return;
  }
  const exitLabel = renderExecExitLabel(session);
  const output = compactNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  if (status === "failed" && session.exitReason === "manual-cancel" && !output) {
    return;
  }
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
  const eventOptions = {
    sessionKey: eventSessionKey,
    contextKey: `exec:${session.id}`,
    deliveryContext: session.notifyDeliveryContext,
    ...(expectedGeneration
      ? {
          sourceGeneration: {
            sessionKey,
            sessionId: expectedGeneration.sessionId,
            ...(expectedGeneration.lifecycleRevision !== undefined
              ? { lifecycleRevision: expectedGeneration.lifecycleRevision }
              : {}),
            ...(eventRouting.sessionStore !== undefined
              ? { sessionStore: eventRouting.sessionStore }
              : {}),
          },
        }
      : {}),
  };
  const remove = enqueueSystemEventWithReceipt(
    eventText,
    eventSessionKey === "global" && session.agentId
      ? withSystemEventOwner(eventOptions, session.agentId)
      : eventOptions,
    { allowDuplicate: true },
  );
  if (remove) {
    recordNotifyOnExitRemoval(session, remove);
  }
  if (!isSubagentSessionKey(sessionKey)) {
    const wakeOptions = scopedHeartbeatWakeOptionsForPolicy(
      sessionKey,
      {
        source: "exec-event" as const,
        intent: "event" as const,
        reason: "exec-event",
        coalesceMs: 0,
        ...(eventRouting.isolateCompletionRun === true
          ? { heartbeat: { isolatedSession: true } }
          : {}),
      },
      eventRouting,
    );
    requestHeartbeat(
      sessionKey === "global" && session.agentId
        ? { ...wakeOptions, agentId: session.agentId }
        : wakeOptions,
    );
  }
}
