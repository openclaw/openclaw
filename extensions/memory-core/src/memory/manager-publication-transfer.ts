import type {
  MemoryEmbeddingCacheEntry,
  MemoryEmbeddingCacheHeader,
  MemoryPublicationFragment,
} from "./manager-publication-task.js";
import type {
  MemorySourceIndexHeader,
  MemorySourceIndexReplacement,
  MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";

const FRAGMENT_CHARS = 16 * 1024;
const BATCH_BYTES = 512 * 1024;
// Numeric JSON uses fewer than 32 characters per item, including its separator.
const NUMERIC_PART_ITEMS = 512;

/** Bound the direct command before serializing; oversized vectors retain streamed staging. */
export function memoryEmbeddingCacheFitsInline(
  header: MemoryEmbeddingCacheHeader,
  entries: readonly MemoryEmbeddingCacheEntry[],
): boolean {
  let bytes =
    512 +
    2 *
      (header.agentId.length +
        header.provider.id.length +
        header.provider.model.length +
        header.providerKey.length);
  for (const entry of entries) {
    bytes +=
      128 + 2 * (entry.hash.length + (entry.sessionId?.length ?? 0)) + 32 * entry.embedding.length;
    if (bytes > BATCH_BYTES) {
      return false;
    }
  }
  // The staged JSON path normalizes invalid numeric values; keep that legacy behavior.
  return bytes <= BATCH_BYTES && entries.every((entry) => entry.embedding.every(Number.isFinite));
}

// Encode at most one bounded string slice at a time. A single oversized record
// must not turn v8.serialize/JSON.stringify into a source-sized host operation.
function* jsonParts(value: unknown, preserveNegativeZero: boolean): Generator<string> {
  if (typeof value === "string") {
    yield '"';
    for (let offset = 0; offset < value.length; offset += FRAGMENT_CHARS) {
      yield JSON.stringify(value.slice(offset, offset + FRAGMENT_CHARS)).slice(1, -1);
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) {
        yield ",";
      }
      const item: unknown = value[index] ?? null;
      if (typeof item === "number") {
        const limit = Math.min(value.length, index + NUMERIC_PART_ITEMS);
        let end = index + 1;
        while (end < limit && typeof value[end] === "number") {
          end++;
        }
        const numbers = value.slice(index, end);
        // Cache vectors preserve their binary values; source rows retain JSON normalization.
        yield preserveNegativeZero
          ? numbers
              .map((number) => (Object.is(number, -0) ? "-0" : JSON.stringify(number)))
              .join(",")
          : JSON.stringify(numbers).slice(1, -1);
        index = end - 1;
      } else {
        yield* jsonParts(item, preserveNegativeZero);
      }
    }
    yield "]";
  } else if (value && typeof value === "object") {
    yield "{";
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        continue;
      }
      if (!first) {
        yield ",";
      }
      first = false;
      yield JSON.stringify(key) + ":";
      yield* jsonParts(item, preserveNegativeZero);
    }
    yield "}";
  } else {
    yield JSON.stringify(value) ?? "null";
  }
}

function* rowFragments(
  value: MemorySourceIndexRow | MemoryEmbeddingCacheEntry,
  preserveNegativeZero: boolean,
): Generator<string> {
  let pending = "";
  for (const part of jsonParts(value, preserveNegativeZero)) {
    pending += part;
    while (pending.length >= FRAGMENT_CHARS) {
      let end = FRAGMENT_CHARS;
      // SQLite TEXT encodes each fragment as UTF-8. Never split a surrogate
      // pair across rows, where each lone half would become a replacement char.
      const last = pending.charCodeAt(end - 1);
      const next = pending.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end--;
      }
      yield pending.slice(0, end);
      pending = pending.slice(end);
    }
  }
  if (pending) {
    yield pending;
  }
}

export function memoryPublicationHeader(replacement: MemorySourceIndexReplacement): {
  header: MemorySourceIndexHeader;
  rows: number;
} {
  const { chunks, embeddings: _embeddings, ...fields } = replacement;
  if (fields.source !== "sessions") {
    return { header: fields, rows: chunks.length };
  }
  // Retained rows travel in the bounded transfer, never the header.
  const { retained = [], ...header } = fields;
  return {
    header: { ...header, delta: retained.length > 0 },
    rows: chunks.length + retained.length,
  };
}

export function* memoryPublicationBatches(
  replacement: MemorySourceIndexReplacement,
): Generator<MemoryPublicationFragment[]> {
  function* rows(): Generator<MemorySourceIndexRow> {
    // The kernel validates every retained row before it writes the first new row.
    const retained = replacement.source === "sessions" ? (replacement.retained ?? []) : [];
    for (const chunk of retained) {
      yield {
        // Retained rows keep their stored text; identity and provenance suffice.
        chunk: { ...row(chunk), text: "" },
        embedding: [],
        retained: true,
      };
    }
    for (const [index, chunk] of replacement.chunks.entries()) {
      yield { chunk: row(chunk), embedding: replacement.embeddings[index] ?? [] };
    }
  }
  function row(chunk: MemorySourceIndexReplacement["chunks"][number]) {
    return {
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
      hash: chunk.hash,
      importance: chunk.importance,
      triggers: chunk.triggers,
      projectKey: chunk.projectKey,
      ...(chunk.provenance ? { provenance: { ...chunk.provenance } } : {}),
    };
  }
  yield* publicationBatches(rows());
}

export function* memoryEmbeddingCacheBatches(
  entries: readonly MemoryEmbeddingCacheEntry[],
): Generator<MemoryPublicationFragment[]> {
  yield* publicationBatches(entries, true);
}

function* publicationBatches(
  rows: Iterable<MemorySourceIndexRow | MemoryEmbeddingCacheEntry>,
  preserveNegativeZero = false,
): Generator<MemoryPublicationFragment[]> {
  let batch: MemoryPublicationFragment[] = [];
  let bytes = 0;
  let row = 0;
  for (const value of rows) {
    const fragments = rowFragments(value, preserveNegativeZero);
    let current = fragments.next();
    let part = 0;
    while (!current.done) {
      const next = fragments.next();
      const cost = Math.max(Buffer.byteLength(current.value), current.value.length * 2) + 128;
      if (batch.length && bytes + cost > BATCH_BYTES) {
        yield batch;
        batch = [];
        bytes = 0;
      }
      batch.push({ row, part: part++, json: current.value, last: next.done === true });
      bytes += cost;
      current = next;
    }
    row++;
  }
  if (batch.length) {
    yield batch;
  }
}
