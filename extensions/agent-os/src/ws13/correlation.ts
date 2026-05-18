// Agent OS WS13 — L1 proof: correlation + Slack mainline classification.
//
// Correlation priority (handoff §11, plan §6):
//   1. exact   — child run/session linkage from spawn/delivery hooks
//   2. strong  — requester sessionKey+runId from reply_dispatch + destination
//   3. weak    — destination match only
//   4. weak    — bounded timing window only
// Weak correlation is NEVER a final pass. Closure is "satisfied" only with
// strong/exact correlation, a non-suppressed dispatch, a successful delivery
// to the originating destination within the bounded window, and — for Slack —
// proven mainline (or an explicitly requested thread).

import type {
  Ws13CorrelationStrength,
  Ws13DeliveryObservation,
  Ws13DispatchObservation,
  Ws13MessageSendingObservation,
  Ws13ObligationRecord,
  Ws13SlackDeliveryClass,
} from "./types.js";

export interface Ws13CorrelationInput {
  obligation: Ws13ObligationRecord;
  dispatches: readonly Ws13DispatchObservation[];
  deliveries: readonly Ws13DeliveryObservation[];
  messageSendings: readonly Ws13MessageSendingObservation[];
  nowMs: number;
  windowMs: number;
}

export interface Ws13CorrelationResult {
  strength: Ws13CorrelationStrength;
  deliverySucceeded: boolean;
  dispatchObserved: boolean;
  dispatchSuppressed: boolean;
  slackDeliveryClass?: Ws13SlackDeliveryClass;
  matchedDispatchId?: string;
  matchedDeliveryId?: string;
  // True only when every condition for visible closure is met.
  closureSatisfied: boolean;
}

function parseMs(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function destinationMatches(
  origin: Ws13ObligationRecord["origin"],
  channel?: string,
  to?: string,
  accountId?: string,
): boolean {
  if (!origin) return false;
  if (!origin.channel || origin.channel !== channel) return false;
  if (!origin.to || origin.to !== to) return false;
  if (origin.accountId && accountId && origin.accountId !== accountId) {
    return false;
  }
  return true;
}

function withinWindow(
  observedAtIso: string,
  endedAtIso: string | undefined,
  nowMs: number,
  windowMs: number,
): boolean {
  const observed = parseMs(observedAtIso);
  if (observed === undefined) return false;
  const ended = parseMs(endedAtIso);
  if (ended !== undefined && observed < ended) return false;
  if (ended !== undefined && observed > ended + windowMs) return false;
  return observed <= nowMs;
}

// Slack classification is intentionally strict. Mainline is proven only by a
// positive pre-send (message_sending) signal that no thread/reply target was
// used. message_sent alone cannot distinguish mainline from thread, so it
// yields "indeterminate" (Scenario F must then be inconclusive/failed).
export function classifySlackDelivery(
  obligation: Ws13ObligationRecord,
  delivery: Ws13DeliveryObservation | undefined,
  messageSendings: readonly Ws13MessageSendingObservation[],
): Ws13SlackDeliveryClass {
  if (obligation.origin?.channel !== "slack") {
    return "not_slack";
  }

  const relevantSendings = messageSendings.filter(
    (m) =>
      m.channel === obligation.origin?.channel &&
      m.to === obligation.origin?.to,
  );

  const threadSignal =
    Boolean(delivery?.threadId) ||
    Boolean(delivery?.replyToId) ||
    relevantSendings.some((m) => Boolean(m.threadId) || Boolean(m.replyToId));

  if (threadSignal) {
    return obligation.explicitThreadDeliveryRequested === true
      ? "thread_explicitly_requested"
      : "thread_unexpected";
  }

  // No thread signal anywhere. Mainline is only PROVEN if a pre-send
  // observation positively shows no thread/reply target. Without it,
  // message_sent absence-of-field is not proof.
  const hasPositiveMainlineSignal = relevantSendings.some(
    (m) => !m.threadId && !m.replyToId,
  );
  return hasPositiveMainlineSignal ? "mainline_proven" : "indeterminate";
}

export function correlate(
  input: Ws13CorrelationInput,
): Ws13CorrelationResult {
  const { obligation, dispatches, deliveries, messageSendings } = input;

  // --- Dispatch correlation ---------------------------------------------
  const matchedDispatch = dispatches.find((d) => {
    if (
      obligation.childRunId &&
      d.runId &&
      d.runId === obligation.childRunId
    ) {
      return true;
    }
    if (
      obligation.requesterSessionKey &&
      d.sessionKey &&
      d.sessionKey === obligation.requesterSessionKey
    ) {
      return true;
    }
    return destinationMatches(
      obligation.origin,
      d.originatingChannel,
      d.originatingTo,
    );
  });

  const dispatchObserved = Boolean(matchedDispatch);
  const dispatchSuppressed = Boolean(
    matchedDispatch &&
      (matchedDispatch.suppressUserDelivery === true ||
        matchedDispatch.sendPolicy === "deny"),
  );

  // --- Delivery correlation ---------------------------------------------
  const matchedDelivery = deliveries.find(
    (d) =>
      d.success &&
      destinationMatches(obligation.origin, d.channel, d.to, d.accountId) &&
      withinWindow(
        d.observedAt,
        obligation.endedAt,
        input.nowMs,
        input.windowMs,
      ),
  );

  const deliverySucceeded = Boolean(matchedDelivery);

  // --- Correlation strength ---------------------------------------------
  let strength: Ws13CorrelationStrength = "none";

  const exactRunLinkage =
    Boolean(
      obligation.childRunId &&
        matchedDispatch?.runId === obligation.childRunId,
    );

  const strongRequesterLinkage =
    Boolean(
      obligation.requesterSessionKey &&
        matchedDispatch?.sessionKey === obligation.requesterSessionKey &&
        matchedDispatch?.runId,
    );

  if (exactRunLinkage && deliverySucceeded) {
    strength = "exact";
  } else if (strongRequesterLinkage && deliverySucceeded) {
    strength = "strong";
  } else if (deliverySucceeded) {
    // Destination + timing only. message_sent carries no sessionKey/runId
    // (source Blocker 1), so this can only ever be weak.
    strength = "weak";
  } else if (dispatchObserved) {
    strength = "weak";
  } else {
    strength = "none";
  }

  const slackDeliveryClass = classifySlackDelivery(
    obligation,
    matchedDelivery,
    messageSendings,
  );

  const slackOk =
    slackDeliveryClass === "not_slack" ||
    slackDeliveryClass === "mainline_proven" ||
    slackDeliveryClass === "thread_explicitly_requested";

  const closureSatisfied =
    deliverySucceeded &&
    dispatchObserved &&
    !dispatchSuppressed &&
    (strength === "exact" || strength === "strong") &&
    slackOk;

  return {
    strength,
    deliverySucceeded,
    dispatchObserved,
    dispatchSuppressed,
    slackDeliveryClass,
    matchedDispatchId: matchedDispatch?.observationId,
    matchedDeliveryId: matchedDelivery?.observationId,
    closureSatisfied,
  };
}
