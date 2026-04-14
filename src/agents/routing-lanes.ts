/**
 * Routing lane definitions for OpenClaw control plane.
 *
 * Lanes classify model selection decisions into named categories
 * so operators can tell why a particular model was chosen and
 * distinguish failover (availability) from escalation (quality).
 */

/** Named routing lanes. */
export type RoutingLane =
  | "routine"
  | "orchestrator_high"
  | "executor_codex"
  | "research"
  | "judge_deterministic"
  | "judge_semantic"
  | "challenger";

/** Why a particular model was selected. */
export type RouteReason =
  | "primary"
  | "session_override"
  | "cron_override"
  | "config_override"
  | "failover"
  | "escalation"
  | "challenger_invocation"
  | "user_request";

/** Quality/complexity escalation reasons (separate from availability failover). */
export type EscalationReason =
  | "revise_loop_exceeded"
  | "architecture_conflict"
  | "migration_risk"
  | "root_cause_ambiguity"
  | "user_requested"
  | "judge_escalate";

/** Full route metadata attached to model selection decisions. */
export interface RouteMetadata {
  /** Which lane this run belongs to. */
  lane?: RoutingLane;
  /** Why this model was selected. */
  routeReason?: RouteReason;
  /** Provider/model that was originally requested. */
  requestedModel?: string;
  /** Provider/model that was selected after resolution. */
  selectedModel?: string;
  /** Provider/model that actually handled the request (may differ due to provider routing). */
  actualModel?: string;
  /** If failover occurred, why. */
  failoverReason?: string;
  /** If escalation occurred, why. */
  escalationReason?: EscalationReason;
  /** Whether a challenger was invoked. */
  challengerInvoked?: boolean;
  /** Why the challenger was invoked. */
  challengerReason?: string;
}

/** Lane descriptions for operator-facing surfaces. */
export const LANE_DESCRIPTIONS: Record<RoutingLane, string> = {
  routine: "Bounded follow-ups, heartbeat, cron, lightweight ops",
  orchestrator_high: "Architecture, migrations, ambiguous bugs, replanning",
  executor_codex: "Code changes, repo execution, deterministic verification",
  research: "Public-web docs, synthesis, verification",
  judge_deterministic: "Tests, lint, typecheck, benchmarks",
  judge_semantic: "Behavior and contract acceptance review",
  challenger: "Explicit second opinion, fresh-session escalation",
};

/** Known model patterns for lane inference. */
const CODEX_PATTERNS = ["openai-codex/", "codex"];
const OPUS_PATTERNS = ["claude-opus", "anthropic/claude-opus"];
const SONNET_PATTERNS = ["claude-sonnet", "anthropic/claude-sonnet"];
const MINI_PATTERNS = ["-mini", "gpt-5-mini", "gpt-5.4-mini"];

/**
 * Infer the routing lane from agent ID and resolved model.
 * This is a heuristic — explicit lane assignment should be preferred.
 */
export function inferRoutingLane(params: {
  agentId?: string;
  model?: string;
  provider?: string;
}): RoutingLane {
  const { agentId, model, provider } = params;
  const modelRef = [provider, model].filter(Boolean).join("/").toLowerCase();

  // Agent-based inference
  if (agentId === "judge") {
    return "judge_semantic";
  }
  if (agentId === "research-agent") {
    return "research";
  }
  if (agentId === "main") {
    if (OPUS_PATTERNS.some((p) => modelRef.includes(p))) {
      return "orchestrator_high";
    }
    return "orchestrator_high"; // main is always orchestrator
  }

  // Model-based inference
  if (CODEX_PATTERNS.some((p) => modelRef.includes(p))) {
    return "executor_codex";
  }
  if (MINI_PATTERNS.some((p) => modelRef.includes(p))) {
    return "routine";
  }
  if (SONNET_PATTERNS.some((p) => modelRef.includes(p))) {
    return "judge_semantic";
  }
  if (OPUS_PATTERNS.some((p) => modelRef.includes(p))) {
    return "orchestrator_high";
  }

  return "routine";
}

/**
 * Build route metadata from model selection context.
 */
export function buildRouteMetadata(params: {
  agentId?: string;
  requestedProvider?: string;
  requestedModel?: string;
  selectedProvider?: string;
  selectedModel?: string;
  routeReason?: RouteReason;
  failoverReason?: string;
  escalationReason?: EscalationReason;
}): RouteMetadata {
  const requested = [params.requestedProvider, params.requestedModel].filter(Boolean).join("/");
  const selected = [params.selectedProvider, params.selectedModel].filter(Boolean).join("/");

  return {
    lane: inferRoutingLane({
      agentId: params.agentId,
      model: params.selectedModel,
      provider: params.selectedProvider,
    }),
    routeReason: params.routeReason ?? (requested !== selected ? "failover" : "primary"),
    requestedModel: requested || undefined,
    selectedModel: selected || undefined,
    failoverReason: params.failoverReason,
    escalationReason: params.escalationReason,
  };
}
