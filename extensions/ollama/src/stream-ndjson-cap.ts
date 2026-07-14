// NDJSON record-size guard for Ollama streaming.
// Ollama streams NDJSON over HTTP; a record without a terminating newline
// could grow without bound. This caps each pending record at 16 MiB of
// raw bytes, resets at every newline, and surfaces an actionable error
// before the chunk is decoded into text.

const OLLAMA_NDJSON_RECORD_MAX_BYTES = 16 * 1024 * 1024;

export function checkNdjsonRecordCap(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  value: Uint8Array,
  pendingRecordBytes: number,
): number {
  let offset = 0;
  let pending = pendingRecordBytes;
  while (offset < value.byteLength) {
    const newlineIndex = value.indexOf(0x0a, offset);
    const segmentEnd = newlineIndex === -1 ? value.byteLength : newlineIndex;
    pending += segmentEnd - offset;
    if (pending > OLLAMA_NDJSON_RECORD_MAX_BYTES) {
      const error = new Error(
        `Ollama NDJSON record exceeds ${OLLAMA_NDJSON_RECORD_MAX_BYTES} bytes`,
      );
      reader.cancel(error).catch(() => undefined);
      throw error;
    }
    if (newlineIndex === -1) {
      break;
    }
    pending = 0;
    offset = newlineIndex + 1;
  }
  return pending;
}
