import { createHash } from "node:crypto";
import zlib from "node:zlib";

// Release proofs decode the persisted contract independently of candidate runtime code.
const MAX_COMPRESSED_EVENT_BYTES = 4 * 1024 * 1024;
const payloadSchemas = new WeakMap();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function hasCompressedPayloads(database) {
  if (!payloadSchemas.has(database)) {
    payloadSchemas.set(
      database,
      Boolean(
        database
          .prepare("SELECT 1 FROM pragma_table_info('transcript_events') WHERE name = 'event_zstd'")
          .get(),
      ),
    );
  }
  return payloadSchemas.get(database);
}

/** Read published legacy fixtures and current candidate databases without migrating either. */
export function sqliteTranscriptPayloadColumns(database) {
  return hasCompressedPayloads(database)
    ? "event_json, event_zstd, event_utf8_bytes"
    : "event_json";
}

/** Bound materialization before decoding any compressed event. */
export function sqliteTranscriptPayloadBytesSql(database) {
  return hasCompressedPayloads(database)
    ? "coalesce(event_utf8_bytes, octet_length(event_json))"
    : "octet_length(event_json)";
}

/** Preserve exact JSON bytes for survivor, backup, and cold-restoration comparisons. */
export function readSqliteTranscriptPayload(row) {
  if (typeof row.event_json === "string" && row.event_zstd == null) {
    return row.event_json;
  }
  const bytes = row.event_zstd;
  const expectedBytes = row.event_utf8_bytes;
  if (
    row.event_json !== null ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_COMPRESSED_EVENT_BYTES ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > MAX_COMPRESSED_EVENT_BYTES
  ) {
    throw new Error("Invalid persisted transcript payload");
  }
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("Transcript verification requires a runtime with Zstd support");
  }
  const decoded = zlib.zstdDecompressSync(bytes, { maxOutputLength: expectedBytes });
  if (decoded.byteLength !== expectedBytes) {
    throw new Error("Persisted transcript payload differs from its recorded UTF-8 size");
  }
  return utf8Decoder.decode(decoded);
}

export function transcriptIdentity(event) {
  // Doctor repairs metadata; the fixture's text-only turn must retain event IDs and messages.
  return {
    type: event.type,
    id: event.id,
    ...(event.type === "message"
      ? {
          role: event.message.role,
          textHash: createHash("sha256")
            .update(
              JSON.stringify(
                typeof event.message.content === "string"
                  ? [event.message.content]
                  : event.message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text),
              ),
            )
            .digest("hex"),
        }
      : {}),
  };
}
