import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import type { Message } from "../../llm/types.js";

const MAX_HISTORY_DIFF_FIELDS = 8;

export type PromptHistoryFingerprint = {
  role: string;
  envelopeFields: Map<string, string>;
  envelopeDigest: string;
  contentKind: "string" | "blocks";
  blocks: string[];
  blockFields: Map<string, string>[];
  stringBlock?: WeakRef<PromptStringFingerprint>;
};

type PromptStringFingerprint = { value: string; digest: string };

const stringFingerprints = new WeakMap<Message, PromptStringFingerprint>();
type RecordFingerprint = {
  digest: string;
  fields: Map<string, string>;
  primitives: Map<string, unknown>;
};
// Primitive revisions avoid rehashing retained text; nested values remain mutable.
const recordFingerprints = new WeakMap<object, RecordFingerprint>();
const immutableValueFingerprints = new WeakMap<object, string>();
export const messageFingerprints = new WeakMap<Message, PromptHistoryFingerprint>();

function fingerprintValue(value: unknown): string {
  if (value && typeof value === "object" && isOwnedTranscriptPayload(value)) {
    const cached = immutableValueFingerprints.get(value);
    if (cached) {
      return cached;
    }
    const digest = sha256Hex(stableStringify(value));
    immutableValueFingerprints.set(value, digest);
    return digest;
  }
  return sha256Hex(stableStringify(value));
}

function fingerprintText(value: string): string {
  // UTF-8 replaces lone surrogates; escape those without serializing ordinary prompt text.
  return value.isWellFormed()
    ? `text:${sha256Hex(value)}`
    : `escaped:${sha256Hex(stableStringify(value))}`;
}

function fingerprintRecord(record: object, omit?: string): RecordFingerprint {
  const previous = recordFingerprints.get(record);
  if (previous && isOwnedTranscriptPayload(record)) {
    return previous;
  }
  let fields = previous ? undefined : new Map<string, string>();
  const primitives = previous?.primitives ?? new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    if (key === omit) {
      continue;
    }
    const primitive = value === null || typeof value !== "object";
    const digest =
      primitive && previous?.primitives.has(key) && Object.is(previous.primitives.get(key), value)
        ? previous.fields.get(key)!
        : typeof value === "string"
          ? fingerprintText(value)
          : fingerprintValue(value);
    if (!previous || previous.fields.get(key) !== digest) {
      (fields ??= new Map(previous?.fields)).set(key, digest);
    }
    if (primitive) {
      primitives.set(key, value);
    } else {
      primitives.delete(key);
    }
  }
  for (const key of previous?.fields.keys() ?? []) {
    if (!Object.hasOwn(record, key)) {
      (fields ??= new Map(previous?.fields)).delete(key);
      primitives.delete(key);
    }
  }
  if (!fields && previous) {
    return previous;
  }
  const fingerprint = {
    digest: sha256Hex(stableStringify(Object.fromEntries(fields!))),
    fields: fields!,
    primitives,
  };
  recordFingerprints.set(record, fingerprint);
  return fingerprint;
}

export function fingerprintMessage(
  message: Message,
  previous?: PromptHistoryFingerprint,
): PromptHistoryFingerprint {
  const cached = messageFingerprints.get(message);
  if (cached) {
    return previous && sameHistoryFingerprint(previous, cached) ? previous : cached;
  }
  const { content } = message;
  let stringBlock: PromptHistoryFingerprint["stringBlock"];
  let blocks: string[];
  let fingerprints: RecordFingerprint[] = [];
  if (typeof content === "string") {
    // Transcript messages own text memos; diagnostics retain only weak references.
    const previousMemo = previous?.stringBlock?.deref() ?? stringFingerprints.get(message);
    const memo =
      previousMemo?.value === content
        ? previousMemo
        : { value: content, digest: fingerprintText(content) };
    stringFingerprints.set(message, memo);
    stringBlock = new WeakRef(memo);
    blocks = [memo.digest];
  } else {
    stringFingerprints.delete(message);
    fingerprints = content.map((block) => fingerprintRecord(block));
    blocks = fingerprints.map(({ digest }) => digest);
  }
  const envelope = fingerprintRecord(message, "content");
  if (
    previous?.envelopeDigest === envelope.digest &&
    previous.contentKind === (typeof content === "string" ? "string" : "blocks") &&
    previous.blocks.length === blocks.length &&
    previous.blocks.every((digest, index) => digest === blocks[index])
  ) {
    return previous;
  }
  const fingerprint: PromptHistoryFingerprint = {
    role: message.role,
    envelopeFields: envelope.fields,
    envelopeDigest: envelope.digest,
    contentKind: typeof content === "string" ? "string" : "blocks",
    blocks,
    blockFields: fingerprints.slice(0, MAX_HISTORY_DIFF_FIELDS).map(({ fields }) => fields),
    stringBlock,
  };
  if (isOwnedTranscriptPayload(message)) {
    messageFingerprints.set(message, fingerprint);
  }
  return fingerprint;
}

function sameHistoryFingerprint(
  previous: PromptHistoryFingerprint,
  next: PromptHistoryFingerprint,
) {
  return (
    previous.envelopeDigest === next.envelopeDigest &&
    previous.contentKind === next.contentKind &&
    previous.blocks.length === next.blocks.length &&
    previous.blocks.every((digest, index) => digest === next.blocks[index])
  );
}
