import type {
  AISafetyEventMetadata,
  DiagnosticEvalResultEvent,
  DiagnosticExternalContentConsumedEvent,
  DiagnosticMemoryContextSelectionEvent,
  DiagnosticPromptInjectionSignalEvent,
  DiagnosticToolPolicyDecisionEvent,
  DiagnosticUserFeedbackReceivedEvent,
} from "../api.js";
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
 *
 * Provenance: every recorder attaches `openclaw.ai_safety.emitter_trusted` from
 * `metadata.trusted` so operators can distinguish core-trusted emissions from
 * plugin-emitted (policy-gated) ones. Note this is distinct from the
 * `openclaw.ai_safety.trusted` attribute on external_content.consumed, which
 * describes the trust level of the consumed content source, not the emitter.
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
    evt: DiagnosticPromptInjectionSignalEvent,
    metadata: AISafetyEventMetadata,
  ) => {
    aiSafetyPromptInjectionSignalCounter.add(1, {
      "openclaw.ai_safety.emitter_trusted": String(metadata.trusted),
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
    evt: DiagnosticToolPolicyDecisionEvent,
    metadata: AISafetyEventMetadata,
  ) => {
    aiSafetyToolPolicyDecisionCounter.add(1, {
      "openclaw.ai_safety.emitter_trusted": String(metadata.trusted),
      "openclaw.ai_safety.tool_name": lowCardinalityAttr(evt.toolName),
      "openclaw.ai_safety.decision": lowCardinalityAttr(evt.decision),
      "openclaw.ai_safety.policy_source": lowCardinalityAttr(evt.policySource),
      "openclaw.ai_safety.severity": evt.severity,
      "openclaw.ai_safety.channel": lowCardinalityAttr(evt.channel, "none"),
    });
  };

  const recordExternalContentConsumed = (
    evt: DiagnosticExternalContentConsumedEvent,
    metadata: AISafetyEventMetadata,
  ) => {
    aiSafetyExternalContentConsumedCounter.add(1, {
      "openclaw.ai_safety.emitter_trusted": String(metadata.trusted),
      "openclaw.ai_safety.source_type": lowCardinalityAttr(evt.sourceType),
      "openclaw.ai_safety.trusted": String(evt.trusted),
      "openclaw.ai_safety.channel": lowCardinalityAttr(evt.channel, "none"),
    });
  };

  const recordUserFeedbackReceived = (
    evt: DiagnosticUserFeedbackReceivedEvent,
    metadata: AISafetyEventMetadata,
  ) => {
    aiSafetyUserFeedbackReceivedCounter.add(1, {
      "openclaw.ai_safety.emitter_trusted": String(metadata.trusted),
      "openclaw.ai_safety.label": lowCardinalityAttr(evt.label),
      "openclaw.ai_safety.channel": lowCardinalityAttr(evt.channel, "none"),
    });
  };

  const recordMemoryContextSelected = (
    evt: DiagnosticMemoryContextSelectionEvent,
    metadata: AISafetyEventMetadata,
  ) => {
    aiSafetyMemoryContextSelectedCounter.add(1, {
      "openclaw.ai_safety.emitter_trusted": String(metadata.trusted),
      "openclaw.ai_safety.memory_type": lowCardinalityAttr(evt.memoryType),
      "openclaw.ai_safety.channel": lowCardinalityAttr(evt.channel, "none"),
    });
  };

  const recordEvalResult = (evt: DiagnosticEvalResultEvent, metadata: AISafetyEventMetadata) => {
    aiSafetyEvalResultCounter.add(1, {
      "openclaw.ai_safety.emitter_trusted": String(metadata.trusted),
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
