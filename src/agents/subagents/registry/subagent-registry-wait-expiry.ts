import { getRuntimeConfig } from "../../../config/config.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { loadSubagentAnnounceModule } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

export const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const SUBAGENT_WAIT_EXPIRY_TERMINAL_GRACE_MS = 250;

/**
 * Publish a wait expiry and wake the parent, without claiming the child stopped.
 *
 * Extracted from the registry module so the publication, its admitted writes and
 * its delivery fences read as one unit (and so `subagent-registry.ts` stays
 * under its line cap).
 */
export async function reportSubagentWaitExpiry({
  entry,
  observedAt,
  startedAt,
  lifecycleGeneration,
}: {
  entry: SubagentRunRecord;
  observedAt: number;
  startedAt?: number;
  lifecycleGeneration: string;
}): Promise<void> {
  // Published rows are frozen and every registry write is admitted in FIFO
  // order through `mutateSubagentRuns`, so both observations commit there.
  // Each commit REPLACES the row, which is why `published` is reacquired from
  // the mutation's postimages: the later delivery fences must test the row
  // that now owns this run, never the preimage this callback was handed.
  let published = entry;
  // A restart may retain the row, but must retire the original wait's writes
  // and delivery authority across both the grace timer and announcement.
  // Read the live row on every fence. Identity against `published` would be
  // wrong here: each admitted commit REPLACES the row, so a `=== published`
  // check fails the moment this callback's own first write lands.
  const liveOwner = () => {
    const current = subagentRuns.get(entry.runId);
    return current !== undefined && isSameSubagentRunOwner(current, published)
      ? current
      : undefined;
  };
  const isCurrent = () => {
    const current = liveOwner();
    return (
      isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
      current !== undefined &&
      !subagentRuns.isCompletionAuthorityRetired(current) &&
      typeof current.execution.endedAt !== "number"
    );
  };
  const ownsObservation = () => isCurrent() && liveOwner()?.waitExpiryObservedAt === observedAt;
  const admits = (current: SubagentRunRecord | undefined): current is SubagentRunRecord =>
    current !== undefined &&
    isSameSubagentRunOwner(current, entry) &&
    typeof current.waitExpiryAnnouncedAt !== "number" &&
    typeof current.execution.endedAt !== "number" &&
    (typeof current.waitExpiryObservedAt !== "number" ||
      current.waitExpiryObservedAt === observedAt);
  const adopt = (
    postimages: ReadonlyMap<string, SubagentRunRecord | null>,
    planned: SubagentRunRecord,
  ) => {
    published = postimages.get(planned.runId) ?? planned;
  };
  if (!isCurrent() || !admits(entry)) {
    return;
  }
  const observation = await mutateSubagentRuns(
    [entry.runId],
    (rows) => {
      const current = rows.get(entry.runId);
      if (!admits(current)) {
        return { value: undefined };
      }
      const next = structuredClone(current);
      next.waitExpiryObservedAt ??= observedAt;
      if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
        next.execution = { ...next.execution, startedAt };
        next.sessionStartedAt ??= startedAt;
      }
      return { value: next, postimages: new Map([[next.runId, next]]) };
    },
    {
      // No `assertCurrent`: a wait expiry that loses its owner mid-commit is a
      // no-op, not an error. The planner above already declines by returning
      // no postimage, and throwing here would propagate out of this callback
      // and abort the wait manager's own terminal settlement.
      onPublished: (postimages, planned) => {
        if (planned) {
          adopt(postimages, planned);
        }
      },
    },
  );
  if (!observation || !ownsObservation()) {
    return;
  }

  // Record the observation before yielding so the sweeper cannot mistake this
  // live-but-unconfirmed child for a lost execution during announcement grace.
  // The grace delays only the wake: an authoritative terminal event still wins.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SUBAGENT_WAIT_EXPIRY_TERMINAL_GRACE_MS);
    timer.unref?.();
  });
  if (!ownsObservation()) {
    return;
  }

  if (published.collect === true || published.expectsCompletionMessage === false) {
    return;
  }
  const announceResult = await (
    await loadSubagentAnnounceModule()
  ).runSubagentAnnounceFlow({
    childSessionKey: published.childSessionKey,
    childRunId: published.runId,
    requesterSessionKey: published.requesterSessionKey,
    requesterAgentId: resolveSubagentRequesterAgentId(getRuntimeConfig(), published),
    requesterOrigin: published.requesterOrigin,
    task: published.task,
    timeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
    cleanup: "keep",
    startedAt,
    endedAt: observedAt,
    label: published.label,
    outcome: { status: "timeout", disposition: "still-running" },
    deliveryPhase: "wait-expiry",
    expectsCompletionMessage: published.expectsCompletionMessage,
    completionTarget: published.completionTarget,
    completionRequesterSessionId: published.completionRequesterSessionId,
    spawnMode: published.spawnMode,
    wakeOnDescendantSettle: published.wakeOnDescendantSettle,
    suppressChildSessionEffects: true,
    isCompletionDeliveryAllowed: ownsObservation,
    resolveGatewayContext: getGatewayContextResolver(published),
  });
  if (
    announceResult !== "delivered" &&
    announceResult !== "intentional_non_delivery" &&
    announceResult !== "permanent_failure"
  ) {
    throw new Error("subagent wait-expiry announcement did not settle");
  }
  if (!ownsObservation()) {
    return;
  }
  await mutateSubagentRuns(
    [published.runId],
    (rows) => {
      const current = rows.get(published.runId);
      if (
        !current ||
        !isSameSubagentRunOwner(current, published) ||
        typeof current.waitExpiryAnnouncedAt === "number" ||
        typeof current.execution.endedAt === "number" ||
        current.waitExpiryObservedAt !== observedAt
      ) {
        return { value: undefined };
      }
      const next = structuredClone(current);
      next.waitExpiryAnnouncedAt = Date.now();
      return { value: next, postimages: new Map([[next.runId, next]]) };
    },
    {
      // No `assertCurrent`: a wait expiry that loses its owner mid-commit is a
      // no-op, not an error. The planner above already declines by returning
      // no postimage, and throwing here would propagate out of this callback
      // and abort the wait manager's own terminal settlement.
      onPublished: (postimages, planned) => {
        if (planned) {
          adopt(postimages, planned);
        }
      },
    },
  );
}
