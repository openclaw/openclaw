import type { DiagnosticEventPayload } from "../api.js";
import { lowCardinalityAttr } from "./service-attributes.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";

/**
 * Recorders for the AI safety/quality event taxonomy.
 *
 * Note on tool_policy.decision overlap: `ai_safety.tool_policy.decision` covers the full
 * decision spectrum (allowed/approval_required/approved/denied/blocked) from the policy
 * evaluation layer. The existing `tool.execution.blocked` event covers the execution
 * sandbox/policy block at invocation time. These two events represent distinct moments in
 * the tool lifecycle and MUST NOT be de-duplicated — they should both be recorded when
 * both events are emitted.
 */
export function createAiSafetyRecorders(runtime: DiagnosticsRecorderRuntime) {
  const {
    aiSafetyPromptInjectionSignalCounter,
    aiSafetyToolPolicyDecisionCounter,
    aiSafetyExternalContentConsumedCounter,
    aiSafetyUserFeedbackReceivedCounter,
    aiSafetyMemoryContextSelectedCounter,
    aiSafetyEvalResultCounter,
  } = runtime;

  const recordPromptInjectionSignal = (
    evt: Extract<DiagnosticEventPayload, { type: "ai_safety.prompt_injection.signal" }>,
  ) => {
    aiSafetyPromptInjectionSignalCounter.add(1, {
      "openclaw.ai_safety.severity": evt.severity,
      "openclaw.ai_safety.category": evt.category,
      "openclaw.ai_safety.action_taken": lowCardinalityAttr(evt.actionTaken),
      "openclaw.ai_safety.source_type": lowCardinalityAttr(evt.sourceType),
      "openclaw.ai_safety.channel": lowCardinalityAttr(evt.channel, "none"),
    });
  };

  /**
   * Records a tool policy decision event.
   *
   * Note: `tool_name` is included as an OTEL counter label here because it is bounded by
   * the set of registered tools (low cardinality in practice). It is intentionally excluded
   * from the Prometheus unified counter to respect the MAX_PROMETHEUS_SERIES cap.
   */
  const recordToolPolicyDecision = (
    evt: Extract<DiagnosticEventPayload, { type: "ai_safety.tool_policy.decision" }>,
  ) => {
    aiSafetyToolPolicyDecisionCounter.add(1, {
      "openclaw.ai_safety.tool_name": lowCardinalityAttr(evt.toolName),
      "openclaw.ai_safety.decision": lowCardinalityAttr(evt.decision),
      "openclaw.ai_safety.policy_source": lowCardinalityAttr(evt.policySource),
      "openclaw.ai_safety.severity": evt.severity,
      "openclaw.ai_safety.channel": lowCardinalityAttr(evt.channel, "none"),
    });
  };

  const recordExternalContentConsumed = (
    evt: Extract<DiagnosticEventPayload, { type: "ai_safety.external_content.consumed" }>,
  ) => {
    aiSafetyExternalContentConsumedCounter.add(1, {
      "openclaw.ai_safety.source_type": lowCardinalityAttr(evt.sourceType),
      "openclaw.ai_safety.trusted": String(evt.trusted),
      "openclaw.ai_safety.channel": lowCardinalityAttr(evt.channel, "none"),
    });
  };

  const recordUserFeedbackReceived = (
    evt: Extract<DiagnosticEventPayload, { type: "ai_safety.user_feedback.received" }>,
  ) => {
    aiSafetyUserFeedbackReceivedCounter.add(1, {
      "openclaw.ai_safety.label": lowCardinalityAttr(evt.label),
      "openclaw.ai_safety.channel": lowCardinalityAttr(evt.channel, "none"),
    });
  };

  const recordMemoryContextSelected = (
    evt: Extract<DiagnosticEventPayload, { type: "ai_safety.memory_context.selected" }>,
  ) => {
    aiSafetyMemoryContextSelectedCounter.add(1, {
      "openclaw.ai_safety.memory_type": lowCardinalityAttr(evt.memoryType),
      "openclaw.ai_safety.channel": lowCardinalityAttr(evt.channel, "none"),
    });
  };

  const recordEvalResult = (
    evt: Extract<DiagnosticEventPayload, { type: "ai_safety.eval.result" }>,
  ) => {
    aiSafetyEvalResultCounter.add(1, {
      "openclaw.ai_safety.eval_name": lowCardinalityAttr(evt.evalName),
      "openclaw.ai_safety.passed": String(evt.passed),
      "openclaw.ai_safety.severity": evt.severity,
      "openclaw.ai_safety.channel": lowCardinalityAttr(evt.channel, "none"),
    });
  };

  return {
    recordPromptInjectionSignal,
    recordToolPolicyDecision,
    recordExternalContentConsumed,
    recordUserFeedbackReceived,
    recordMemoryContextSelected,
    recordEvalResult,
  };
}
