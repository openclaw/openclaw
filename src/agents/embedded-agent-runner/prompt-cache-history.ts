import { hash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import type { Message } from "../../llm/types.js";

const MAX_HISTORY_DIFF_FIELDS = 8;
// Persistence-only metadata is absent from provider messages; content is hashed separately.
const MESSAGE_ENVELOPE_OMITTED_FIELDS = new Set(["content", "__openclaw", "display"]);

export type PromptHistoryFingerprint = {
  role: string;
  identityLength: number;
  layout: string;
  packed: string;
  stringBlock?: WeakRef<PromptStringFingerprint>;
};

type PromptStringFingerprint = { value: string; digest: string };

const stringFingerprints = new WeakMap<Message, PromptStringFingerprint>();
type RecordFingerprint = {
  digest: string;
  fields: Map<string, string>;
  primitives: Map<string, unknown>;
  immutable: boolean;
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
    const digest = `j${hash("sha256", stableStringify(value), "latin1")}`;
    immutableValueFingerprints.set(value, digest);
    return digest;
  }
  return `j${hash("sha256", stableStringify(value), "latin1")}`;
}

function fingerprintText(value: string): string {
  // UTF-8 replaces lone surrogates; escape those without serializing ordinary prompt text.
  return value.isWellFormed()
    ? `t${hash("sha256", value, "latin1")}`
    : `e${hash("sha256", stableStringify(value), "latin1")}`;
}

function fingerprintRecord(
  record: object,
  omit?: ReadonlySet<string>,
  immutableParent = false,
): RecordFingerprint {
  const previous = recordFingerprints.get(record);
  if (previous?.immutable) {
    return previous;
  }
  const immutable = immutableParent || isOwnedTranscriptPayload(record);
  let fields = previous ? undefined : new Map<string, string>();
  const primitives = previous?.primitives ?? new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    if (omit?.has(key)) {
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
    previous.immutable = immutable;
    return previous;
  }
  const fingerprint = {
    digest: hash("sha256", stableStringify(Object.fromEntries(fields!)), "latin1"),
    fields: fields!,
    primitives,
    immutable,
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
    if (
      previous &&
      (previous === cached ||
        (previous.identityLength === cached.identityLength &&
          previous.packed.startsWith(cached.packed.slice(0, cached.identityLength))))
    ) {
      messageFingerprints.set(message, previous);
      return previous;
    }
    return cached;
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
    // Append normalization owns the content root and freezes every descendant.
    const immutableContent = isOwnedTranscriptPayload(content);
    fingerprints = content.map((block) => fingerprintRecord(block, undefined, immutableContent));
    blocks = fingerprints.map(({ digest }) => digest);
  }
  const envelope = fingerprintRecord(message, MESSAGE_ENVELOPE_OMITTED_FIELDS);
  const identity = [typeof content === "string" ? "t" : "b", envelope.digest, ...blocks].join("");
  if (previous?.identityLength === identity.length && previous.packed.startsWith(identity)) {
    return previous;
  }
  const records = [envelope, ...fingerprints.slice(0, MAX_HISTORY_DIFF_FIELDS)];
  const fingerprint: PromptHistoryFingerprint = {
    role: message.role,
    identityLength: identity.length,
    // Flat Latin-1 strings retain full SHA-256 bytes without per-hash objects.
    // The identity prefix precedes fixed-width, domain-tagged field hashes.
    layout: JSON.stringify(records.map(({ fields }) => Array.from(fields.keys()))),
    packed: [identity, ...records.flatMap(({ fields }) => Array.from(fields.values()))].join(""),
    stringBlock,
  };
  if (isOwnedTranscriptPayload(message)) {
    messageFingerprints.set(message, fingerprint);
  }
  return fingerprint;
}
