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
  location: string;
  locationNote?: string;
  content: string;
};

/** Keep model-facing context separate from the complete, unmodified instruction body. */
export function formatSkillInstructions(result: SkillInstructionResult): string {
  const context = [
    `Skill location: ${result.location}`,
    "Resolve relative resource paths from the directory containing this SKILL.md.",
  ];
  if (result.locationNote) {
    context.push(result.locationNote);
  }
  return `${context.join("\n")}\n\n${result.content}`;
}
