import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { hasDiagnosticTracePropagationConsumer } from "../infra/diagnostic-trace-propagation.js";

// Private result metadata never changes model-facing content or serialized tool details.
// The delivery promise shares the same lifetime as the existing whole-read cache.
const deliveredFingerprints = new WeakMap<object, string>();

export function rememberSkillInstructionDelivery(
  result: object,
  content: string,
  delivery?: object,
): void {
  if (!hasDiagnosticTracePropagationConsumer()) {
    return;
  }
  const fingerprint = sha256Hex(content);
  deliveredFingerprints.set(result, fingerprint);
  if (delivery) {
    deliveredFingerprints.set(delivery, fingerprint);
  }
}

/**
 * Remembers the copy a skill read handed to the harness so a later tool-result
 * middleware pass can tell whether that copy reached the model unshortened.
 */
const deliveredSkillCopies = new Map<string, { fingerprint: string; forget: () => void }>();
const MAX_TRACKED_SKILL_DELIVERIES = 64;

export function rememberSkillInstructionDeliveryForToolCall(params: {
  toolCallId: string;
  content: string;
  forget: () => void;
}): void {
  const { toolCallId, content, forget } = params;
  if (deliveredSkillCopies.size >= MAX_TRACKED_SKILL_DELIVERIES) {
    const oldest = deliveredSkillCopies.keys().next();
    if (!oldest.done) {
      deliveredSkillCopies.delete(oldest.value);
    }
  }
  deliveredSkillCopies.set(toolCallId, { fingerprint: sha256Hex(content), forget });
}

/**
 * Compares the copy a skill read delivered with the copy the model received and
 * drops the whole-read cache entry when a tool-result reducer shortened it.
 */
export function reconcileSkillInstructionDelivery(params: {
  toolCallId: string;
  deliveredText: string | undefined;
}): void {
  const recorded = deliveredSkillCopies.get(params.toolCallId);
  if (!recorded) {
    return;
  }
  deliveredSkillCopies.delete(params.toolCallId);
  const { deliveredText } = params;
  if (deliveredText !== undefined && sha256Hex(deliveredText) === recorded.fingerprint) {
    return;
  }
  recorded.forget();
}

export function createAlreadyDeliveredSkillResult(delivery: object) {
  const text =
    "Skill instructions were already served whole earlier in the current model context. Reuse that content; the full document will be served again if compaction removes it.";
  const result = {
    content: [{ type: "text" as const, text }],
    details: { kind: "text" as const, content: text },
  };
  const fingerprint = deliveredFingerprints.get(delivery);
  if (fingerprint) {
    deliveredFingerprints.set(result, fingerprint);
  }
  return result;
}

export function getSkillInstructionFingerprint(result: unknown): string | undefined {
  return result && typeof result === "object" && hasDiagnosticTracePropagationConsumer()
    ? deliveredFingerprints.get(result)
    : undefined;
}

export type SkillInstructionResult = {
  name: string;
  relativePath?: string;
  location: string;
  locationNote?: string;
  content: string;
};

/** Keep model-facing context separate from the complete, unmodified instruction body. */
export function formatSkillInstructions(result: SkillInstructionResult): string {
  if (result.relativePath !== undefined) {
    return result.content;
  }
  const context = [
    `Skill location: ${result.location}`,
    "Resolve relative resource paths from the directory containing this SKILL.md.",
  ];
  if (result.locationNote) {
    context.push(result.locationNote);
  }
  return `${context.join("\n")}\n\n${result.content}`;
}
