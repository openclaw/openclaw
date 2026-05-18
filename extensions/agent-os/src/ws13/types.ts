// Agent OS WS13 — L1 pure-plugin simulated handler/unit proof: metadata-only types.
//
// This file is a non-production proof contract. It models the no-orphaned
// delegated-closure obligation using only metadata-shaped fields that mirror
// the real OpenClaw plugin hook payloads. It intentionally never declares
// content-bearing fields (task text, prompts, transcripts, reply bodies,
// images, attachments, raw error text). Revised from the Forge residual
// types.ts: same metadata-only/privacy-first intent, extended to match the
// source-grounded hook shapes and the required scenario/health/alert model.

export const WS13_REQUIRED_HOOKS = [
  "subagent_spawning",
  "subagent_delivery_target",
  "subagent_spawned",
  "subagent_ended",
  "reply_dispatch",
  "message_sent",
] as const;

export type Ws13RequiredHookName = (typeof WS13_REQUIRED_HOOKS)[number];
export type Ws13OptionalHookName = "message_sending";
export type Ws13HookName = Ws13RequiredHookName | Ws13OptionalHookName;

export type Ws13ScenarioLabel = "A" | "B" | "C" | "D" | "E" | "F" | "G";

// pass: required outcome reached. fail: wrong/silent outcome. inconclusive:
// metadata insufficient to decide (must NOT be reported as pass). unsupported:
// path correctly classified as unsupported/unhealthy (loud, not silent).
export type Ws13ScenarioStatus =
  | "pass"
  | "fail"
  | "inconclusive"
  | "unsupported";

export type Ws13CorrelationStrength = "none" | "weak" | "strong" | "exact";

export type Ws13HealthState =
  | "healthy_simulated"
  | "unhealthy_required_hook_missing"
  | "unhealthy_store_unavailable"
  | "unhealthy_correlation_insufficient"
  | "unhealthy_plugin_inactive"
  | "unsupported_or_unhealthy";

// Obligation lifecycle. Note: "satisfied" is terminal-success and must never be
// reached on child completion alone (see correlation.ts / hook-handlers.ts).
export type Ws13ObligationStatus =
  | "candidate"
  | "pending"
  | "no_obligation_inline"
  | "child_completed"
  | "child_failed"
  | "child_timeout"
  | "child_killed"
  | "unsupported_completion_path"
  | "dispatch_observed"
  | "dispatch_suppressed"
  | "delivery_observed"
  | "satisfied"
  | "missing_closure_alert_required"
  | "unsupported_or_unhealthy";

export type Ws13CoarseErrorCategory =
  | "adapter_error"
  | "missing_destination"
  | "suppressed_delivery"
  | "required_hook_missing"
  | "store_unavailable"
  | "correlation_insufficient"
  | "plugin_inactive"
  | "unknown_error";

// Static/simulated classification only. No live alert is ever sent in L1.
export type Ws13AlertCapability =
  | "alert_capable_via_reply_dispatch"
  | "alert_capable_via_approved_plugin_api"
  | "alert_not_source_proven";

// Slack mainline vs thread classification. Mainline is the default visible
// closure target; thread is acceptable only when explicitly requested.
export type Ws13SlackDeliveryClass =
  | "mainline_proven"
  | "thread_explicitly_requested"
  | "thread_unexpected"
  | "indeterminate"
  | "not_slack";

export interface Ws13OriginMetadata {
  channel?: string;
  accountId?: string;
  // threadId is opaque metadata only (coerced to string); never content.
  to?: string;
  threadId?: string;
}

export interface Ws13ClosureWindowConfig {
  // Bounded simulated verification window, milliseconds. Recorded in evidence.
  verificationWindowMs: number;
}

export interface Ws13ObligationRecord {
  obligationId: string;
  childSessionKey?: string;
  childRunId?: string;
  requesterSessionKey?: string;
  origin?: Ws13OriginMetadata;
  spawnMode?: string;
  expectsCompletionMessage?: boolean;
  createdAt: string;
  endedAt?: string;
  closureDueAt?: string;
  status: Ws13ObligationStatus;
  health: Ws13HealthState;
  evidenceRefs: string[];
  correlationStrength: Ws13CorrelationStrength;
  errorCategoryOnly?: Ws13CoarseErrorCategory;
  explicitThreadDeliveryRequested?: boolean;
  slackDeliveryClass?: Ws13SlackDeliveryClass;
  alertCapability?: Ws13AlertCapability;
}

export interface Ws13DispatchObservation {
  observationId: string;
  sessionKey?: string;
  runId?: string;
  originatingChannel?: string;
  originatingTo?: string;
  sendPolicy?: string;
  suppressUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  isTailDispatch?: boolean;
  shouldRouteToOriginating?: boolean;
  observedAt: string;
}

export interface Ws13DeliveryObservation {
  observationId: string;
  channel?: string;
  accountId?: string;
  conversationId?: string;
  to?: string;
  messageId?: string;
  success: boolean;
  errorCategoryOnly?: Ws13CoarseErrorCategory;
  observedAt: string;
  threadId?: string;
  replyToId?: string;
}

export interface Ws13MessageSendingObservation {
  observationId: string;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  replyToId?: string;
  observedAt: string;
}

export interface Ws13TransitionEvidence {
  evidenceId: string;
  scenario?: Ws13ScenarioLabel;
  hookName?: Ws13HookName | "self_check" | "closure_window";
  timestamp: string;
  obligationId?: string;
  from?: Ws13ObligationStatus;
  to?: Ws13ObligationStatus;
  status?: Ws13ScenarioStatus;
  correlationStrength?: Ws13CorrelationStrength;
  health?: Ws13HealthState;
  errorCategoryOnly?: Ws13CoarseErrorCategory;
}

export interface Ws13ScenarioResult {
  scenario: Ws13ScenarioLabel;
  status: Ws13ScenarioStatus;
  obligationId?: string;
  correlationStrength: Ws13CorrelationStrength;
  health: Ws13HealthState;
  finalObligationStatus?: Ws13ObligationStatus;
  slackDeliveryClass?: Ws13SlackDeliveryClass;
  alertCapability?: Ws13AlertCapability;
  statusTransitions: Ws13TransitionEvidence[];
  errorCategoryOnly?: Ws13CoarseErrorCategory;
  // Metadata-only human notes. Must never contain task/prompt/reply content.
  notes: string[];
}

export interface Ws13ProofResult {
  generatedAt: string;
  executionMode: "simulated_metadata_only";
  privacyMode: "metadata_only_content_dropped";
  closureWindow: Ws13ClosureWindowConfig;
  requiredHooks: readonly Ws13RequiredHookName[];
  results: Ws13ScenarioResult[];
  // "prepared" = logic authored but harness not executed (L1 command not run).
  overallStatus: "prepared" | "pass" | "fail" | "inconclusive";
}

export interface Ws13SelfCheckInput {
  pluginActive: boolean;
  storeAvailable: boolean;
  availableHooks: readonly string[];
}

export interface Ws13SelfCheckResult {
  health: Ws13HealthState;
  missingHooks: Ws13RequiredHookName[];
  active: boolean;
  // Whether delegated-closure enforcement may be reported as active. Always
  // false unless all required hooks present, store available, plugin active.
  enforcementActive: boolean;
}

// A simulated hook invocation: a hook name plus a metadata-only payload that
// structurally mirrors the real OpenClaw event (content fields omitted at the
// fixture source AND defensively dropped again on ingest).
export interface Ws13HookEnvelope {
  scenario?: Ws13ScenarioLabel;
  hookName: Ws13HookName;
  timestamp: string;
  payload: Record<string, unknown>;
}
