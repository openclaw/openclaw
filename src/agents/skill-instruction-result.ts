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
 *
 * Deliveries are scoped to the attempt that served them: provider tool-call ids are
 * only unique inside one response, so two sessions can both legitimately use
 * `call_1` and must never consume each other's records. Several deliveries can also
 * land on one id, because a Code Mode exec result delivers every nested read it made.
 */
type PendingSkillDelivery = {
  content: string;
  fingerprint: string;
  /** Set once a nested read has been reparented onto the outer exec result. */
  wrapped: boolean;
  forget: () => void;
};

const pendingSkillDeliveries = new Map<string, PendingSkillDelivery[]>();
const MAX_TRACKED_SKILL_DELIVERIES = 64;
const MAX_DELIVERIES_PER_TOOL_CALL = 16;

function deliveryKey(runId: string | undefined, toolCallId: string): string {
  return `${runId ?? ""}\u0000${toolCallId}`;
}

function takeDeliveries(
  runId: string | undefined,
  toolCallId: string,
): PendingSkillDelivery[] | undefined {
  const key = deliveryKey(runId, toolCallId);
  const records = pendingSkillDeliveries.get(key);
  if (records) {
    pendingSkillDeliveries.delete(key);
  }
  return records;
}

function pendingDeliveryCount(): number {
  let total = 0;
  for (const records of pendingSkillDeliveries.values()) {
    total += records.length;
  }
  return total;
}

export function rememberSkillInstructionDeliveryForToolCall(params: {
  runId: string | undefined;
  toolCallId: string;
  content: string;
  forget: () => void;
}): void {
  const key = deliveryKey(params.runId, params.toolCallId);
  const records = pendingSkillDeliveries.get(key) ?? [];
  if (records.length >= MAX_DELIVERIES_PER_TOOL_CALL) {
    records.shift()?.forget();
  }
  records.push({
    content: params.content,
    fingerprint: sha256Hex(params.content),
    wrapped: false,
    forget: params.forget,
  });
  pendingSkillDeliveries.set(key, records);
  while (pendingDeliveryCount() > MAX_TRACKED_SKILL_DELIVERIES) {
    const oldest = pendingSkillDeliveries.keys().next();
    if (oldest.done) {
      break;
    }
    pendingSkillDeliveries.delete(oldest.value);
  }
}

/**
 * Moves a nested read's delivery onto the tool call whose result will carry it.
 * Code Mode runs the read tool inside its own exec call, so the session's
 * tool-result hook sees the outer id and would otherwise never reconcile the copy.
 */
export function reparentSkillInstructionDelivery(params: {
  runId: string | undefined;
  nestedToolCallId: string;
  parentToolCallId: string;
}): void {
  const { runId, nestedToolCallId, parentToolCallId } = params;
  if (nestedToolCallId === parentToolCallId) {
    return;
  }
  const records = takeDeliveries(runId, nestedToolCallId);
  if (!records) {
    return;
  }
  const parentKey = deliveryKey(runId, parentToolCallId);
  const parentRecords = pendingSkillDeliveries.get(parentKey) ?? [];
  for (const record of records) {
    record.wrapped = true;
  }
  parentRecords.push(...records);
  pendingSkillDeliveries.set(parentKey, parentRecords);
}

/**
 * Compares the copy a skill read delivered with the copy the model received and
 * drops the whole-read cache entry when a tool-result reducer shortened it.
 *
 * A direct read must reach the model byte for byte, so any rewrite drops the cache.
 * A reparented nested read is only checked for presence: the outer exec result wraps
 * the copy in console output, and reformatting it there is not a reason to re-serve
 * the whole document. Missing it means the reducer dropped the copy, so the cache is
 * dropped too and the next read serves the document again.
 */
export function reconcileSkillInstructionDelivery(params: {
  runId: string | undefined;
  toolCallId: string;
  deliveredText: string | undefined;
}): void {
  const records = takeDeliveries(params.runId, params.toolCallId);
  if (!records) {
    return;
  }
  const { deliveredText } = params;
  for (const record of records) {
    const intact = record.wrapped
      ? deliveredText !== undefined && deliveredText.includes(record.content)
      : deliveredText !== undefined && sha256Hex(deliveredText) === record.fingerprint;
    if (!intact) {
      record.forget();
    }
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
