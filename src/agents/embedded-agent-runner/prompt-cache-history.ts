import { hash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
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
type RecordFingerprint =
  | {
      digest: string;
      fields: Map<string, string>;
      primitives: Record<string, unknown>;
      immutable: false;
      message?: { content: Message["content"]; fingerprint: PromptHistoryFingerprint };
    }
  | { digest: string; layout: string; packed: string; immutable: true };
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
  const primitives: Record<string, unknown> | undefined = immutable
    ? undefined
    : (previous?.primitives ?? {});
  for (const [key, value] of Object.entries(record)) {
    if (omit?.has(key)) {
      continue;
    }
    const primitive = value === null || typeof value !== "object";
    const digest =
      primitive &&
      previous &&
      Object.hasOwn(previous.primitives, key) &&
      Object.is(previous.primitives[key], value)
        ? previous.fields.get(key)!
        : typeof value === "string"
          ? fingerprintText(value)
          : fingerprintValue(value);
    if (!previous || previous.fields.get(key) !== digest) {
      (fields ??= new Map(previous?.fields)).set(key, digest);
    }
    if (primitives) {
      if (!primitive) {
        delete primitives[key];
      } else if (key === "__proto__") {
        // Revision keys are data, including the legacy prototype setter name.
        Object.defineProperty(primitives, key, { value, writable: true, configurable: true });
      } else {
        primitives[key] = value;
      }
    }
  }
  for (const key of previous?.fields.keys() ?? []) {
    if (!Object.hasOwn(record, key)) {
      (fields ??= new Map(previous?.fields)).delete(key);
      if (primitives) {
        delete primitives[key];
      }
    }
  }
  if (!fields && previous && !immutable) {
    return previous;
  }
  const digest = fields
    ? hash("sha256", stableStringify(Object.fromEntries(fields)), "latin1")
    : previous!.digest;
  fields ??= previous!.fields;
  // Sealed records never check primitive revisions again. Retain only diagnostic bytes.
  const fingerprint: RecordFingerprint = immutable
    ? {
        digest,
        layout: JSON.stringify(Array.from(fields.keys())),
        packed: Array.from(fields.values()).join(""),
        immutable: true,
      }
    : { digest, fields, primitives: primitives!, immutable: false };
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
      previous !== cached &&
      previous.identityLength === cached.identityLength &&
      previous.packed.startsWith(cached.packed.slice(0, cached.identityLength))
    ) {
      messageFingerprints.set(message, previous);
      return previous;
    }
    return cached;
  }
  const immutableMessage = isOwnedTranscriptPayload(message) || isDeeplyFrozenPlainData(message);
  const { content } = message;
  const envelope = fingerprintRecord(message, MESSAGE_ENVELOPE_OMITTED_FIELDS);
  // The record owner replaces this revision when any envelope field changes.
  // Only immutable content may reuse it; mutable SDK content still needs inspection.
  const retained = !envelope.immutable && envelope.message;
  if (
    !immutableMessage &&
    retained &&
    retained.content === content &&
    (!previous || previous === retained.fingerprint)
  ) {
    return retained.fingerprint;
  }
  const immutableContent =
    typeof content === "string" ||
    immutableMessage ||
    isOwnedTranscriptPayload(content) ||
    isDeeplyFrozenPlainData(content);
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
    fingerprints = content.map((block) => fingerprintRecord(block, undefined, immutableContent));
    blocks = fingerprints.map(({ digest }) => digest);
  }
  const identity = [typeof content === "string" ? "t" : "b", envelope.digest, ...blocks].join("");
  let fingerprint: PromptHistoryFingerprint;
  if (previous?.identityLength === identity.length && previous.packed.startsWith(identity)) {
    fingerprint = previous;
  } else {
    const records = [envelope, ...fingerprints.slice(0, MAX_HISTORY_DIFF_FIELDS)];
    fingerprint = {
      role: message.role,
      identityLength: identity.length,
      // Flat Latin-1 strings retain full SHA-256 bytes without per-hash objects.
      // The identity prefix precedes fixed-width, domain-tagged field hashes.
      // Join flattens; template concatenation would retain cons-string cells per message.
      layout: [
        "[",
        records
          .map((record) =>
            record.immutable ? record.layout : JSON.stringify(Array.from(record.fields.keys())),
          )
          .join(","),
        "]",
      ].join(""),
      packed: [
        identity,
        ...records.map((record) =>
          record.immutable ? record.packed : Array.from(record.fields.values()).join(""),
        ),
      ].join(""),
      stringBlock,
    };
  }
  if (immutableMessage) {
    messageFingerprints.set(message, fingerprint);
    // Content records may still be reused by other, mutable envelopes.
    recordFingerprints.delete(message);
  } else if (!envelope.immutable) {
    envelope.message = immutableContent ? { content, fingerprint } : undefined;
  }
  return fingerprint;
}

// Known fields retain stable markers; other diagnostics name bounded keys, never values.
const HISTORY_ENVELOPE_FIELDS = new Set([
  "role",
  "timestamp",
  "idempotencyKey",
  "usage",
  "api",
  "provider",
  "model",
  "stopReason",
  "errorMessage",
  "toolCallId",
  "toolName",
  "isError",
  "runtimeContext",
  "runtimeContextCarrier",
  "operatorMessage",
]);
const HISTORY_BLOCK_FIELDS = new Set([
  "type",
  "text",
  "textSignature",
  "thinking",
  "thinkingSignature",
  "openclawReasoningReplay",
  "id",
  "name",
  "arguments",
  "partialJson",
  "async",
  "thoughtSignature",
  "data",
  "mimeType",
  "index",
]);

function describeHistoryField(key: string, known: ReadonlySet<string>) {
  return known.has(key) ? key : `other[${JSON.stringify(sanitizeForLog(key).slice(0, 80))}]`;
}

function unpackHistoryFingerprint(fingerprint: PromptHistoryFingerprint) {
  // One kind byte and a 32-byte envelope digest precede the ordered content hashes.
  // Text and field hashes also carry a one-byte domain tag.
  const contentKind = fingerprint.packed[0] === "t" ? "string" : "blocks";
  const blocks: string[] = [];
  const width = contentKind === "string" ? 33 : 32;
  for (let offset = 33; offset < fingerprint.identityLength; offset += width) {
    blocks.push(fingerprint.packed.slice(offset, offset + width));
  }
  const layout: string[][] = JSON.parse(fingerprint.layout);
  let offset = fingerprint.identityLength;
  const fields = layout.map(
    (keys) =>
      new Map(
        keys.map((key) => {
          const digest = fingerprint.packed.slice(offset, offset + 33);
          offset += 33;
          return [key, digest];
        }),
      ),
  );
  return { contentKind, blocks, envelopeFields: fields[0]!, blockFields: fields.slice(1) };
}

/** Names the bounded fields that differ between two fingerprints, never their values. */
export function describeHistoryChange(
  previousFingerprint: PromptHistoryFingerprint,
  nextFingerprint: PromptHistoryFingerprint | undefined,
): string {
  if (!nextFingerprint) {
    return "message removed";
  }
  const previous = unpackHistoryFingerprint(previousFingerprint);
  const next = unpackHistoryFingerprint(nextFingerprint);
  const fields: string[] = [];
  if (previous.contentKind !== next.contentKind) {
    fields.push("content.type");
  }
  if (
    previous.blocks.length !== next.blocks.length ||
    previous.blocks.some((digest, index) => digest !== next.blocks[index])
  ) {
    if (previous.contentKind === "string" || next.contentKind === "string") {
      fields.push("content");
    } else {
      if (previous.blocks.length !== next.blocks.length) {
        fields.push("content.length");
      }
      for (
        let index = 0;
        index <
        Math.min(MAX_HISTORY_DIFF_FIELDS, Math.max(previous.blocks.length, next.blocks.length));
        index++
      ) {
        if (previous.blocks[index] !== next.blocks[index]) {
          const before = previous.blockFields[index];
          const after = next.blockFields[index];
          const changed = [
            ...new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])]),
          ].filter((key) => before?.get(key) !== after?.get(key));
          fields.push(
            ...(changed.length
              ? new Set(
                  changed.map(
                    (key) => `content[${index}].${describeHistoryField(key, HISTORY_BLOCK_FIELDS)}`,
                  ),
                )
              : [`content[${index}]`]),
          );
        }
      }
      if (
        previous.blocks.some(
          (digest, index) => index >= MAX_HISTORY_DIFF_FIELDS && digest !== next.blocks[index],
        ) ||
        (previous.blocks.length !== next.blocks.length &&
          Math.max(previous.blocks.length, next.blocks.length) > MAX_HISTORY_DIFF_FIELDS)
      ) {
        fields.push("content[remaining]");
      }
    }
  }
  for (const key of new Set([...previous.envelopeFields.keys(), ...next.envelopeFields.keys()])) {
    if (previous.envelopeFields.get(key) !== next.envelopeFields.get(key)) {
      const field = `envelope.${describeHistoryField(key, HISTORY_ENVELOPE_FIELDS)}`;
      if (!fields.includes(field)) {
        fields.push(field);
      }
    }
  }
  return `changed fields: ${fields.slice(0, MAX_HISTORY_DIFF_FIELDS).join(", ")}${fields.length > MAX_HISTORY_DIFF_FIELDS ? ", …" : ""}`;
}
