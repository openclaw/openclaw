import { randomBytes } from "node:crypto";

// `m13` is intentional: the persisted receipt surface was first spec'd in M13,
// and M14 is landing the implementation without renaming stored envelope ids.
export const EMBEDDED_RUN_LIFECYCLE_SURFACE = "m13_lifecycle_seam_v1" as const;
export const EMBEDDED_RUN_LIFECYCLE_SEAM_VERSION = 1 as const;

export type EmbeddedRunPassKind = "model_call" | "tool_round" | "compaction";
export type EmbeddedRunTransitionSource = "retry_limit" | "prompt" | "assistant" | "pass_dispatch";

export type EmbeddedRunLifecycleControllerProfile =
  | "single-pass"
  | "double-pass"
  | "verifier-heavy";

export type EmbeddedRunLifecycleControllerPlan = {
  requestedProfile: EmbeddedRunLifecycleControllerProfile;
  plannedMaxPasses: number;
  controllerLabel?: string;
};

export const EMBEDDED_RUN_LIFECYCLE_DECISION_MODES = ["observe_only", "decide"] as const;
export type EmbeddedRunLifecycleDecisionMode =
  (typeof EMBEDDED_RUN_LIFECYCLE_DECISION_MODES)[number];

export const EMBEDDED_RUN_LIFECYCLE_DECISION_NEXT_VALUES = ["noop", "continue", "halt"] as const;
export type EmbeddedRunLifecycleDecisionNext =
  (typeof EMBEDDED_RUN_LIFECYCLE_DECISION_NEXT_VALUES)[number];

export type EmbeddedRunLifecycleBaseEvent = {
  runtimeSurface: typeof EMBEDDED_RUN_LIFECYCLE_SURFACE;
  lifecycleSeamVersion: typeof EMBEDDED_RUN_LIFECYCLE_SEAM_VERSION;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  provider: string;
  modelId: string;
  passIndex: number;
  passKind: EmbeddedRunPassKind;
  correlationId: string;
};

export type EmbeddedRunPassStartEvent = EmbeddedRunLifecycleBaseEvent & {
  event: "pass_start";
};

export type EmbeddedRunPassEndEvent = EmbeddedRunLifecycleBaseEvent & {
  event: "pass_end";
  outcome: "success" | "prompt_error" | "assistant_retry" | "aborted" | "timed_out";
  stopReason?: string;
};

export type EmbeddedRunPassTransitionDecisionEvent = EmbeddedRunLifecycleBaseEvent & {
  event: "pass_transition_decision";
  source: EmbeddedRunTransitionSource;
  proposedAction: string;
  proposedReason?: string | null;
  envelopeOnly: true;
  decisionEffective: false;
};

export type EmbeddedRunLifecycleReceipt = {
  runtimeSurface: typeof EMBEDDED_RUN_LIFECYCLE_SURFACE;
  lifecycleSeamVersion: typeof EMBEDDED_RUN_LIFECYCLE_SEAM_VERSION;
  event:
    | EmbeddedRunPassStartEvent["event"]
    | EmbeddedRunPassEndEvent["event"]
    | EmbeddedRunPassTransitionDecisionEvent["event"];
  passIndex: number;
  passKind: EmbeddedRunPassKind;
  correlationId: string;
  envelopeOnly: boolean;
  decisionEffective: boolean;
  outcome: "observed" | "noop" | "error";
  reason?: string;
  unsupportedCapabilities?: string[];
  annotations?: Record<string, unknown>;
};

export type EmbeddedRunLifecycleDecisionResult = {
  next: EmbeddedRunLifecycleDecisionNext;
  reason?: string;
  unsupportedCapabilities?: string[];
  annotations?: Record<string, unknown>;
};

export type EmbeddedRunLifecycleSeam = {
  onPassStart?: (event: EmbeddedRunPassStartEvent) => void | Promise<void>;
  onPassEnd?: (event: EmbeddedRunPassEndEvent) => void | Promise<void>;
  onPassTransitionDecision?: (
    event: EmbeddedRunPassTransitionDecisionEvent,
  ) =>
    | EmbeddedRunLifecycleDecisionResult
    | void
    | Promise<EmbeddedRunLifecycleDecisionResult | void>;
};

export function createExecutionProfileLifecycleSeam(
  plan: EmbeddedRunLifecycleControllerPlan,
): EmbeddedRunLifecycleSeam {
  const normalizedPassCount = Number.isFinite(plan.plannedMaxPasses)
    ? Math.trunc(plan.plannedMaxPasses)
    : 1;
  const maxPasses = Math.max(1, normalizedPassCount);
  return {
    async onPassTransitionDecision(event) {
      if (event.source !== "pass_dispatch") {
        return { next: "noop" };
      }
      if (event.passIndex >= maxPasses) {
        return {
          next: "noop",
          annotations: {
            requestedProfile: plan.requestedProfile,
            plannedMaxPasses: maxPasses,
            controllerLabel: plan.controllerLabel ?? "policy_bound_lifecycle_bridge",
          },
        };
      }
      return {
        next: "continue",
        reason: `execution_profile:${plan.requestedProfile}`,
        annotations: {
          requestedProfile: plan.requestedProfile,
          plannedMaxPasses: maxPasses,
          controllerLabel: plan.controllerLabel ?? "policy_bound_lifecycle_bridge",
        },
      };
    },
  };
}

export function createEmbeddedRunLifecycleCorrelationId(): string {
  return randomBytes(8).toString("hex");
}

export function createEmbeddedRunLifecycleBaseEvent(params: {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  provider: string;
  modelId: string;
  passIndex: number;
  passKind: EmbeddedRunPassKind;
  correlationId?: string;
}): EmbeddedRunLifecycleBaseEvent {
  return {
    runtimeSurface: EMBEDDED_RUN_LIFECYCLE_SURFACE,
    lifecycleSeamVersion: EMBEDDED_RUN_LIFECYCLE_SEAM_VERSION,
    runId: params.runId,
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    provider: params.provider,
    modelId: params.modelId,
    passIndex: params.passIndex,
    passKind: params.passKind,
    correlationId: params.correlationId ?? createEmbeddedRunLifecycleCorrelationId(),
  };
}

/**
 * M14-A stable receipt envelope, later extended so live-effective decision slices
 * can emit truthful non-envelope receipts without changing the persisted surface id.
 */
export function buildEmbeddedRunLifecycleReceipt(params: {
  event:
    | EmbeddedRunPassStartEvent
    | EmbeddedRunPassEndEvent
    | EmbeddedRunPassTransitionDecisionEvent;
  outcome: EmbeddedRunLifecycleReceipt["outcome"];
  reason?: string;
  annotations?: Record<string, unknown>;
  unsupportedCapabilities?: string[];
  envelopeOnly?: boolean;
  decisionEffective?: boolean;
}): EmbeddedRunLifecycleReceipt {
  return {
    runtimeSurface: params.event.runtimeSurface,
    lifecycleSeamVersion: params.event.lifecycleSeamVersion,
    event: params.event.event,
    passIndex: params.event.passIndex,
    passKind: params.event.passKind,
    correlationId: params.event.correlationId,
    envelopeOnly: params.envelopeOnly ?? true,
    decisionEffective: params.decisionEffective ?? false,
    outcome: params.outcome,
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.unsupportedCapabilities
      ? { unsupportedCapabilities: params.unsupportedCapabilities }
      : {}),
    ...(params.annotations ? { annotations: params.annotations } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEmbeddedRunLifecycleDecisionResult(
  value: unknown,
): EmbeddedRunLifecycleDecisionResult | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error(
      "Embedded run lifecycle seam returned a malformed decision result (expected object).",
    );
  }
  const next = value.next;
  if (
    typeof next !== "string" ||
    !EMBEDDED_RUN_LIFECYCLE_DECISION_NEXT_VALUES.includes(next as never)
  ) {
    return {
      next: "noop",
      unsupportedCapabilities: [`invalid_next:${String(next)}`],
    };
  }
  const reason = value.reason;
  if (reason !== undefined && typeof reason !== "string") {
    throw new Error("Embedded run lifecycle seam returned a non-string decision `reason`.");
  }
  const annotations = value.annotations;
  if (annotations !== undefined && !isPlainObject(annotations)) {
    throw new Error("Embedded run lifecycle seam returned non-object `annotations`.");
  }
  const unsupportedCapabilities = value.unsupportedCapabilities;
  if (
    unsupportedCapabilities !== undefined &&
    (!Array.isArray(unsupportedCapabilities) ||
      unsupportedCapabilities.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error("Embedded run lifecycle seam returned invalid `unsupportedCapabilities`.");
  }
  return {
    next: next as EmbeddedRunLifecycleDecisionNext,
    ...(reason !== undefined ? { reason } : {}),
    ...(unsupportedCapabilities !== undefined ? { unsupportedCapabilities } : {}),
    ...(annotations !== undefined ? { annotations } : {}),
  };
}

export async function resolveEmbeddedRunPassTransitionDecision(params: {
  seam?: EmbeddedRunLifecycleSeam;
  event: EmbeddedRunPassTransitionDecisionEvent;
  decisionMode?: EmbeddedRunLifecycleDecisionMode;
}): Promise<EmbeddedRunLifecycleDecisionResult> {
  const decisionMode = params.decisionMode ?? "observe_only";
  if (!EMBEDDED_RUN_LIFECYCLE_DECISION_MODES.includes(decisionMode)) {
    throw new Error(
      `Embedded run lifecycle seam received unsupported decision mode (${decisionMode}).`,
    );
  }
  const result = normalizeEmbeddedRunLifecycleDecisionResult(
    await params.seam?.onPassTransitionDecision?.(params.event),
  );
  if (!result) {
    return { next: "noop" };
  }
  if (decisionMode !== "decide" && result.next !== "noop") {
    throw new Error(
      `Embedded run lifecycle seam received unsupported non-noop decision (${result.next}) while decision mode is ${decisionMode}.`,
    );
  }
  return result;
}
