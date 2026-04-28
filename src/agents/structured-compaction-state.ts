import crypto from "node:crypto";

export type StructuredCompactionEnvelopeV1 = {
  v: 1;
  /** Unix ms */
  createdAt: number;
  /** Optional free-form state to preserve across compactions. */
  state: Record<string, unknown>;
  /** SHA-256 checksum of the envelope payload (excluding this field). */
  checksum: string;
};

export type StructuredCompactionEnvelope = StructuredCompactionEnvelopeV1;

const START = "<openclaw_compaction_state>";
const END = "</openclaw_compaction_state>";

function computeChecksumV1(payload: {
  v: 1;
  createdAt: number;
  state: Record<string, unknown>;
}): string {
  // Stable JSON encoding: rely on JS insertion order from object literals.
  const json = JSON.stringify(payload);
  return crypto.createHash("sha256").update(json).digest("hex");
}

export function createEnvelopeV1(state: Record<string, unknown>): StructuredCompactionEnvelopeV1 {
  const payload = {
    v: 1 as const,
    createdAt: Date.now(),
    state: state ?? {},
  };
  return {
    ...payload,
    checksum: computeChecksumV1(payload),
  };
}

export function serializeEnvelope(envelope: StructuredCompactionEnvelope): string {
  return `${START}${JSON.stringify(envelope)}${END}`;
}

export function extractEnvelope(summary: string | undefined): {
  withoutEnvelope: string | undefined;
  envelope?: StructuredCompactionEnvelope;
  parseError?: string;
} {
  if (!summary) {
    return { withoutEnvelope: summary };
  }
  const startIdx = summary.indexOf(START);
  if (startIdx < 0) {
    return { withoutEnvelope: summary };
  }
  const endIdx = summary.indexOf(END, startIdx + START.length);
  if (endIdx < 0) {
    // Keep text but drop malformed tail.
    return { withoutEnvelope: summary.slice(0, startIdx).trimEnd(), parseError: "missing end" };
  }
  const json = summary.slice(startIdx + START.length, endIdx);
  const without = (summary.slice(0, startIdx) + summary.slice(endIdx + END.length)).trim();
  try {
    const parsed = JSON.parse(json) as StructuredCompactionEnvelope;
    if (!parsed || typeof parsed !== "object") {
      return { withoutEnvelope: without, parseError: "invalid json" };
    }
    if ((parsed as { v?: unknown }).v !== 1) {
      return { withoutEnvelope: without, parseError: "unsupported version" };
    }
    const env = parsed;
    if (typeof env.createdAt !== "number" || !Number.isFinite(env.createdAt)) {
      return { withoutEnvelope: without, parseError: "invalid createdAt" };
    }
    if (!env.state || typeof env.state !== "object") {
      return { withoutEnvelope: without, parseError: "invalid state" };
    }
    if (typeof env.checksum !== "string" || !env.checksum.trim()) {
      return { withoutEnvelope: without, parseError: "missing checksum" };
    }
    const expected = computeChecksumV1({ v: 1, createdAt: env.createdAt, state: env.state });
    if (expected !== env.checksum) {
      return { withoutEnvelope: without, parseError: "checksum mismatch" };
    }
    return { withoutEnvelope: without, envelope: env };
  } catch (err) {
    return {
      withoutEnvelope: without,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

export function mergeEnvelopeState(params: {
  prior?: StructuredCompactionEnvelope;
  next?: Record<string, unknown>;
}): StructuredCompactionEnvelope {
  const mergedState = {
    ...params.prior?.state,
    ...params.next,
  };
  return createEnvelopeV1(mergedState);
}

export function attachEnvelope(summary: string, envelope?: StructuredCompactionEnvelope): string {
  if (!envelope) {
    return summary;
  }
  const trimmed = summary.trim();
  // Always append on a new line to keep summaries readable.
  return `${trimmed}\n\n${serializeEnvelope(envelope)}`;
}
