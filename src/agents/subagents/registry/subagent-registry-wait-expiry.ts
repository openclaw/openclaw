import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { loadSubagentAnnounceModule } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

/**
 * The runtime owns configured execution deadlines and commonly emits its
 * terminal event in the same clock tick as `agent.wait` expires. Give that
 * authoritative event one brief turn to win before publishing a still-live
 * observation; this avoids a duplicate provisional wake for normal timeouts.
 */
const SUBAGENT_WAIT_EXPIRY_TERMINAL_GRACE_MS = 250;

export type ReportSubagentWaitExpiryParams = {
  entry: SubagentRunRecord;
  observedAt: number;
  startedAt?: number;
  lifecycleGeneration: string;
  announceTimeoutMs: number;
};

/**
 * Publishes the provisional "the waiter stopped waiting, the child did not
 * stop" wake, and the durable markers that fence it.
 *
 * Both markers are committed registry facts: they go through the registry
 * worker and are only true once its commit is acknowledged. Nothing here writes
 * a resident row in place — published rows are frozen, and a committed write
 * replaces the row object, so ownership is followed through the run's runtime
 * owner rather than object equality with the record this was handed.
 */
export async function reportSubagentWaitExpiry({
  entry,
  observedAt,
  startedAt,
  lifecycleGeneration,
  announceTimeoutMs,
}: ReportSubagentWaitExpiryParams): Promise<void> {
  // A restart may retain the run, but must retire the original wait's writes
  // and delivery authority across both the grace timer and the announcement.
  const liveRun = () => {
    const current = subagentRuns.get(entry.runId);
    return isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
      current &&
      isSameSubagentRunOwner(current, entry) &&
      typeof current.execution.endedAt !== "number"
      ? current
      : undefined;
  };
  const ownsObservation = () => liveRun()?.waitExpiryObservedAt === observedAt;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SUBAGENT_WAIT_EXPIRY_TERMINAL_GRACE_MS);
    timer.unref?.();
  });
  // The observation becomes a fact only once the registry worker acknowledges
  // it; the published postimage is what every later owner check reads.
  const observed = await mutateSubagentRuns([entry.runId], (rows) => {
    const current = rows.get(entry.runId);
    if (
      !current ||
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
      !isSameSubagentRunOwner(current, entry) ||
      typeof current.execution.endedAt === "number" ||
      typeof current.waitExpiryAnnouncedAt === "number" ||
      (typeof current.waitExpiryObservedAt === "number" &&
        current.waitExpiryObservedAt !== observedAt)
    ) {
      return { value: false };
    }
    const next: SubagentRunRecord = { ...current, waitExpiryObservedAt: observedAt };
    if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
      next.execution = { ...current.execution, startedAt };
      next.sessionStartedAt = current.sessionStartedAt ?? startedAt;
    }
    return { value: true, postimages: new Map([[entry.runId, next]]) };
  });
  const observedRun = observed ? liveRun() : undefined;
  if (
    !observedRun ||
    observedRun.collect === true ||
    observedRun.expectsCompletionMessage === false
  ) {
    return;
  }
  const announceResult = await (
    await loadSubagentAnnounceModule()
  ).runSubagentAnnounceFlow({
    childSessionKey: observedRun.childSessionKey,
    childRunId: observedRun.runId,
    requesterSessionKey: observedRun.requesterSessionKey,
    requesterAgentId: observedRun.requesterAgentId,
    requesterOrigin: observedRun.requesterOrigin,
    task: observedRun.task,
    timeoutMs: announceTimeoutMs,
    cleanup: "keep",
    startedAt,
    endedAt: observedAt,
    label: observedRun.label,
    outcome: { status: "timeout", disposition: "still-running" },
    deliveryPhase: "wait-expiry",
    expectsCompletionMessage: observedRun.expectsCompletionMessage,
    completionTarget: observedRun.completionTarget,
    completionRequesterSessionId: observedRun.completionRequesterSessionId,
    spawnMode: observedRun.spawnMode,
    wakeOnDescendantSettle: observedRun.wakeOnDescendantSettle,
    suppressChildSessionEffects: true,
    isCompletionDeliveryAllowed: ownsObservation,
    resolveGatewayContext: getGatewayContextResolver(observedRun),
  });
  if (
    announceResult !== "delivered" &&
    announceResult !== "intentional_non_delivery" &&
    announceResult !== "permanent_failure"
  ) {
    throw new Error("subagent wait-expiry announcement did not settle");
  }
  // A settlement marker that never commits must surface: the waiter re-arms on
  // the throw, so the notification is retried rather than silently lost.
  const announcedAt = Date.now();
  await mutateSubagentRuns([entry.runId], (rows) => {
    const current = rows.get(entry.runId);
    if (
      !current ||
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
      !isSameSubagentRunOwner(current, entry) ||
      typeof current.execution.endedAt === "number" ||
      current.waitExpiryObservedAt !== observedAt ||
      typeof current.waitExpiryAnnouncedAt === "number"
    ) {
      return { value: undefined };
    }
    return {
      value: undefined,
      postimages: new Map([[entry.runId, { ...current, waitExpiryAnnouncedAt: announcedAt }]]),
    };
  });
}
