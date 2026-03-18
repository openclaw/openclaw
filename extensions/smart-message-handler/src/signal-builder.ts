import { toMessageClassification } from "./classifier.ts";
import type { LocaleKey } from "./locale.ts";
import type { ExecutionIntent, PreComputedVerdict, MessageClassification } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

const CLASSIFIER_VERSION = "2.0-weighted";

/**
 * Build a structured pre-computed verdict from a classified ExecutionIntent.
 * Downstream consumers can read this directly instead of re-running classification.
 */
export function buildPreComputedVerdict(intent: ExecutionIntent): PreComputedVerdict {
  return {
    input_finalized: intent.input_finalized,
    execution_expected: intent.execution_expected,
    execution_kind: intent.execution_kind,
    classifier_version: CLASSIFIER_VERSION,
  };
}

/**
 * Build a concise message classification signal from a MessageClassification.
 * Returns null when the input is not finalized or classified as chat.
 */
export function buildDynamicExecutionSignal(
  classification: MessageClassification,
  _locale?: LocaleKey,
): string | null;
/**
 * @deprecated Use the MessageClassification overload. This overload exists for backward compatibility.
 */
export function buildDynamicExecutionSignal(
  intent: ExecutionIntent,
  _locale?: LocaleKey,
): string | null;
export function buildDynamicExecutionSignal(
  input: MessageClassification | ExecutionIntent,
  _locale: LocaleKey = "zh-CN",
): string | null {
  const classification = isMessageClassification(input)
    ? input
    : toMessageClassification(input, 0, DEFAULT_CONFIG);

  if (!classification.execution_expected) {
    return null;
  }

  if (classification.kind === "chat") {
    return null;
  }

  return `
<message_classification>
<kind>${classification.kind}</kind>
<confidence>${classification.confidence}</confidence>
<input_finalized>${classification.input_finalized}</input_finalized>
<execution_expected>${classification.execution_expected}</execution_expected>
<suggested_tier>${classification.suggested_tier}</suggested_tier>
<score>${classification.score}</score>
<classifier_version>${classification.classifier_version}</classifier_version>
</message_classification>
`.trim();
}

/**
 * Build execution mode signal for agent.
 * Accepts both MessageClassification and ExecutionIntent for backward compatibility.
 */
export function buildExecutionSignal(
  input: MessageClassification | ExecutionIntent,
  locale: LocaleKey = "zh-CN",
): string | null {
  return buildDynamicExecutionSignal(input as MessageClassification, locale);
}

function isMessageClassification(
  input: MessageClassification | ExecutionIntent,
): input is MessageClassification {
  return "kind" in input && "confidence" in input && "suggested_tier" in input;
}
