import type { MemoryPublicationFragment } from "./manager-publication-task.js";
import type {
  MemorySourceIndexReplacement,
  MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";

const FRAGMENT_CHARS = 16 * 1024;
const BATCH_BYTES = 512 * 1024;
// Numeric JSON uses fewer than 32 characters per item, including its separator.
const NUMERIC_PART_ITEMS = 512;

// Encode at most one bounded string slice at a time. A single oversized record
// must not turn v8.serialize/JSON.stringify into a source-sized host operation.
function* jsonParts(value: unknown): Generator<string> {
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
        yield JSON.stringify(value.slice(index, end)).slice(1, -1);
        index = end - 1;
      } else {
        yield* jsonParts(item);
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
      yield* jsonParts(item);
    }
    yield "}";
  } else {
    yield JSON.stringify(value) ?? "null";
  }
}

function* rowFragments(value: MemorySourceIndexRow): Generator<string> {
  let pending = "";
  for (const part of jsonParts(value)) {
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

export function* memoryPublicationBatches(
  replacement: MemorySourceIndexReplacement,
): Generator<MemoryPublicationFragment[]> {
  let batch: MemoryPublicationFragment[] = [];
  let bytes = 0;
  for (const [row, chunk] of replacement.chunks.entries()) {
    const fragments = rowFragments({
      chunk: {
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        hash: chunk.hash,
        importance: chunk.importance,
        triggers: chunk.triggers,
        projectKey: chunk.projectKey,
        ...(chunk.provenance ? { provenance: { ...chunk.provenance } } : {}),
      },
      embedding: replacement.embeddings[row] ?? [],
    });
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
  }
  if (batch.length) {
    yield batch;
  }
}
