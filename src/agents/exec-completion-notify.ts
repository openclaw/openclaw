/**
 * Wakes the requester session about a completed background exec.
 *
 * A backgrounded exec that finishes while its requester session is busy cannot
 * rely on the idle heartbeat wake alone: that wake is skipped as
 * \`requests-in-flight\`, so the completion is also steered into the session's
 * active or next turn through \`exec-steering-queue.ts\`. The durable system
 * event and the heartbeat wake remain the fallback for a fully idle session.
 * The owner lives beside the exec runtime so \`bash-tools.exec-runtime.ts\`
 * stays within its line-cap budget.
 *
 * The steering copy carries the same agent owner and occurrence key
 * (\`exec:<sessionId>\`) as the durable system event, and also its durable
 * event id, so the two representations share one identity: another agent
 * sharing a literal session key cannot lease this output, and settling either
 * representation retires the other through the shared consumption observer,
 * keyed on the globally-unique durable id rather than the reusable occurrence.
 */
import {
  resolveEventSessionKeyForPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../infra/event-session-routing.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import type { ProcessSession } from "./bash-process-registry.js";
import { renderExecExitLabel } from "./bash-tools.exec-output.js";
import { enqueueExecSteeringCompletion } from "./exec-steering-queue.js";

/** Steers one exec completion into the requester session and wakes that session. */
export function steerExecCompletionToRequester(params: {
  session: ProcessSession;
  sessionKey: string;
  status: "completed" | "failed";
  output: string;
  durableEventId?: string;
}): void {
  const { session, sessionKey, status, output, durableEventId } = params;
  const eventRouting = session.eventRouting ?? {};
  enqueueExecSteeringCompletion({
    requesterSessionKey: resolveEventSessionKeyForPolicy(sessionKey, eventRouting),
    ...(session.agentId ? { ownerAgentId: session.agentId } : {}),
    // Shared occurrence identity with the durable system event enqueued in
    // bash-tools.exec-runtime.ts (contextKey `exec:<sessionId>`).
    occurrenceKey: `exec:${session.id}`,
    // Bind to the durable event's globally-unique id so settlement on any path
    // retires exactly this copy through the shared consumption observer.
    ...(durableEventId ? { durableEventId } : {}),
    execId: session.id.slice(0, 8),
    status,
    exitLabel: renderExecExitLabel(session),
    text: output,
    endedAt: Date.now(),
  });
  const wakeOptions = scopedHeartbeatWakeOptionsForPolicy(
    sessionKey,
    {
      source: "exec-event" as const,
      intent: "event" as const,
      reason: "exec-event",
      coalesceMs: 0,
    },
    eventRouting,
  );
  requestHeartbeat(
    sessionKey === "global" && session.agentId
      ? { ...wakeOptions, agentId: session.agentId }
      : wakeOptions,
  );
}
