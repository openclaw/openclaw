type SubagentDeliveryPath =
  | "steered"
  | "direct"
  | "none"
  /**
   * The trigger message was committed to the requester's in-process
   * durable system-event inbox because the direct agent-call dispatch
   * returned a non-terminal pending status (e.g., gateway accepted but
   * parent is yielded/queued/compaction-prep). The parent drains the
   * inbox at next turn-start. Treated as a delivered path; downstream
   * consumers that previously short-circuited on `direct`/`steered`
   * should treat `durable_queue` as durable as well.
   */
  | "durable_queue";
export type SubagentAnnounceDeliveryFailureReason =
  | "completion_handoff_pending"
  | "generated_media_missing"
  | "message_tool_delivery_missing"
  | "requester_abandoned"
  | "visible_reply_missing";

type SubagentAnnounceSteerOutcome =
  | { status: "steered"; deliveredAt?: number; enqueuedAt?: number }
  | { status: "none" | "dropped" };

export type SubagentAnnounceDeliveryResult = {
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  reason?: SubagentAnnounceDeliveryFailureReason;
  error?: string;
  terminal?: boolean;
  phases?: SubagentAnnounceDispatchPhaseResult[];
};

type SubagentAnnounceDispatchPhase = "steer-primary" | "direct-primary" | "steer-fallback";

type SubagentAnnounceDispatchPhaseResult = {
  phase: SubagentAnnounceDispatchPhase;
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  reason?: SubagentAnnounceDeliveryFailureReason;
  error?: string;
};

export function mapSteerOutcomeToDeliveryResult(
  outcome: SubagentAnnounceSteerOutcome,
): SubagentAnnounceDeliveryResult {
  if (outcome.status === "steered") {
    return {
      delivered: true,
      path: "steered",
      deliveredAt: outcome.deliveredAt,
      enqueuedAt: outcome.enqueuedAt,
    };
  }
  return {
    delivered: false,
    path: "none",
  };
}

export async function runSubagentAnnounceDispatch(params: {
  expectsCompletionMessage: boolean;
  signal?: AbortSignal;
  steer: () => Promise<SubagentAnnounceSteerOutcome>;
  direct: () => Promise<SubagentAnnounceDeliveryResult>;
}): Promise<SubagentAnnounceDeliveryResult> {
  const phases: SubagentAnnounceDispatchPhaseResult[] = [];
  const appendPhase = (
    phase: SubagentAnnounceDispatchPhase,
    result: SubagentAnnounceDeliveryResult,
  ) => {
    phases.push({
      phase,
      delivered: result.delivered,
      path: result.path,
      deliveredAt: result.deliveredAt,
      enqueuedAt: result.enqueuedAt,
      ...(result.reason ? { reason: result.reason } : {}),
      error: result.error,
    });
  };
  const withPhases = (result: SubagentAnnounceDeliveryResult): SubagentAnnounceDeliveryResult => ({
    ...result,
    phases,
  });

  if (params.signal?.aborted) {
    return withPhases({
      delivered: false,
      path: "none",
    });
  }

  if (!params.expectsCompletionMessage) {
    const primarySteerOutcome = await params.steer();
    const primarySteer = mapSteerOutcomeToDeliveryResult(primarySteerOutcome);
    appendPhase("steer-primary", primarySteer);
    if (primarySteer.delivered) {
      return withPhases(primarySteer);
    }
    if (primarySteerOutcome.status === "dropped") {
      return withPhases(primarySteer);
    }

    const primaryDirect = await params.direct();
    appendPhase("direct-primary", primaryDirect);
    return withPhases(primaryDirect);
  }

  const primaryDirect = await params.direct();
  appendPhase("direct-primary", primaryDirect);
  if (primaryDirect.delivered || primaryDirect.terminal) {
    return withPhases(primaryDirect);
  }

  if (params.signal?.aborted) {
    return withPhases(primaryDirect);
  }

  const fallbackSteerOutcome = await params.steer();
  const fallbackSteer = mapSteerOutcomeToDeliveryResult(fallbackSteerOutcome);
  appendPhase("steer-fallback", fallbackSteer);
  if (fallbackSteer.delivered) {
    return withPhases(fallbackSteer);
  }

  return withPhases(primaryDirect);
}
