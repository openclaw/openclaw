import { hash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import type { Message } from "../../llm/types.js";
import { isDeeplyFrozenPlainData } from "../../shared/immutable-data.js";

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
// Nested values are rehashed; only primitive revisions can reuse a field digest.
const NESTED_VALUE = Symbol("nested fingerprint value");
type FingerprintField = [key: string, primitive: unknown, digest: string];
type RecordFingerprint =
  | { digest: string; fields: FingerprintField[]; immutable: false }
  | { digest: string; layout: string; packed: string; immutable: true };
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
  let fields: FingerprintField[] | undefined = previous ? undefined : [];
  for (const [key, value] of Object.entries(record)) {
    if (omit?.has(key)) {
      continue;
    }
    const primitive = value === null || typeof value !== "object";
    const index = previous?.fields.findIndex(([name]) => name === key) ?? -1;
    const previousField = previous?.fields[index];
    const digest =
      primitive && previousField && Object.is(previousField[1], value)
        ? previousField[2]
        : typeof value === "string"
          ? fingerprintText(value)
          : fingerprintValue(value);
    if (!previousField || previousField[2] !== digest) {
      fields ??= previous!.fields.slice();
      fields[index < 0 ? fields.length : index] = [key, primitive ? value : NESTED_VALUE, digest];
    } else {
      previousField[1] = primitive ? value : NESTED_VALUE;
    }
  }
  if (previous?.fields.some(([key]) => !Object.hasOwn(record, key))) {
    fields = (fields ?? previous.fields).filter(([key]) => Object.hasOwn(record, key));
  }
  if (!fields && previous && !immutable) {
    return previous;
  }
  const digest = fields
    ? hash(
        "sha256",
        stableStringify(Object.fromEntries(fields.map(([key, , value]) => [key, value]))),
        "latin1",
      )
    : previous!.digest;
  fields ??= previous!.fields;
  // Sealed records never check primitive revisions again. Retain only diagnostic bytes.
  const fingerprint: RecordFingerprint = immutable
    ? {
        digest,
        layout: JSON.stringify(fields.map(([key]) => key)),
        packed: fields.map((field) => field[2]).join(""),
        immutable: true,
      }
    : { digest, fields, immutable: false };
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
  const immutableMessage = isOwnedTranscriptPayload(message) || isDeeplyFrozenPlainData(message);
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
    const immutableContent =
      immutableMessage || isOwnedTranscriptPayload(content) || isDeeplyFrozenPlainData(content);
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
    // Join flattens; template concatenation would retain cons-string cells per message.
    layout: [
      "[",
      records
        .map((record) =>
          record.immutable ? record.layout : JSON.stringify(record.fields.map(([key]) => key)),
        )
        .join(","),
      "]",
    ].join(""),
    packed: [
      identity,
      ...records.map((record) =>
        record.immutable ? record.packed : record.fields.map((field) => field[2]).join(""),
      ),
    ].join(""),
    stringBlock,
  };
  if (immutableMessage) {
    messageFingerprints.set(message, fingerprint);
    // Content records may still be reused by other, mutable envelopes.
    recordFingerprints.delete(message);
  }
  return fingerprint;
}
