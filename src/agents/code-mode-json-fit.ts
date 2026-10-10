import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

export function createJsonPrefixFitter(
  text: string,
  maxBytes: number,
  overhead: (prefixBytes: number) => number,
) {
  const bytes = Buffer.byteLength(text, "utf8");
  let encoded: Buffer | undefined;
  let completeBytes: number | undefined;
  // Model-budget trials share this fitter; retain sparse UTF-8 boundaries to avoid rescanning.
  const checkpoints: Array<{ end: number; jsonBytes: number }> = [];
  let nextCheckpoint = 256;
  return (limit: number): string => {
    if (limit <= 0) {
      return "";
    }
    // Whole fits preserve lone surrogates; partial UTF-8 decoding replaces them.
    if (bytes <= limit && (completeBytes ??= jsonUtf8Bytes(text)) + overhead(bytes) <= limit) {
      return text;
    }
    encoded ??= Buffer.from(text.slice(0, Math.ceil(Math.min(bytes, maxBytes))));
    let end = 0;
    let jsonBytes = 2;
    let low = 0;
    let high = checkpoints.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const checkpoint = checkpoints[middle]!;
      if (checkpoint.end <= limit && checkpoint.jsonBytes + overhead(checkpoint.end) <= limit) {
        end = checkpoint.end;
        jsonBytes = checkpoint.jsonBytes;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    while (end < encoded.byteLength) {
      const byte = encoded[end]!;
      const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      const next = end + width;
      // A failed whole fit cannot become a different full string by replacing surrogates.
      if (next >= bytes || next > limit) {
        break;
      }
      jsonBytes +=
        byte === 34 ||
        byte === 92 ||
        byte === 8 ||
        byte === 9 ||
        byte === 10 ||
        byte === 12 ||
        byte === 13
          ? 2
          : byte < 32
            ? 6
            : width;
      if (jsonBytes + overhead(next) > limit) {
        break;
      }
      end = next;
      if (end >= nextCheckpoint) {
        checkpoints.push({ end, jsonBytes });
        nextCheckpoint = end + 256;
      }
    }
    return encoded.subarray(0, end).toString("utf8");
  };
}
