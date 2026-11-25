import { estimateToolResultTextChars } from "./embedded-agent-runner/tool-result-text-budget.js";

type JsonBudget = { chars: number; contextChars: number };
type JsonPrefix = { text: string; bytes: number; jsonBytes: number; budget: JsonBudget };

export function createJsonPrefixFitter(
  text: string,
  maxBytes: number,
  overhead: (prefixBytes: number) => number,
) {
  const bytes = Buffer.byteLength(text, "utf8");
  let encoded: Buffer | undefined;
  let completeJson: string | undefined;
  let completeBytes: number | undefined;
  let completeBudget: JsonBudget | undefined;
  let measuredEnd = 0;
  let extraChars = 0;
  let extraContextChars = 0;
  // Model-budget trials share this fitter; retain sparse UTF-8 boundaries to avoid rescanning.
  const checkpoints: Array<{ end: number; jsonBytes: number }> = [];
  let nextCheckpoint = 256;
  return (limit: number): JsonPrefix => {
    if (limit <= 0) {
      return { text: "", bytes: 0, jsonBytes: 2, budget: { chars: 2, contextChars: 4 } };
    }
    // Whole fits preserve lone surrogates; partial UTF-8 decoding replaces them.
    if (
      bytes <= limit &&
      (completeBytes ??= Buffer.byteLength((completeJson ??= JSON.stringify(text)), "utf8")) +
        overhead(bytes) <=
        limit
    ) {
      return {
        text,
        bytes,
        jsonBytes: completeBytes,
        get budget() {
          return (completeBudget ??= {
            chars: estimateToolResultTextChars(completeJson!),
            contextChars: estimateToolResultTextChars(completeJson!, { minimumRawWeight: 2 }),
          });
        },
      };
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
      const nextJsonBytes =
        jsonBytes +
        (byte === 34 ||
        byte === 92 ||
        byte === 8 ||
        byte === 9 ||
        byte === 10 ||
        byte === 12 ||
        byte === 13
          ? 2
          : byte < 32
            ? 6
            : width);
      if (nextJsonBytes + overhead(next) > limit) {
        break;
      }
      end = next;
      jsonBytes = nextJsonBytes;
      if (end >= nextCheckpoint) {
        checkpoints.push({ end, jsonBytes });
        nextCheckpoint = end + 256;
      }
    }
    const source = encoded;
    let prefixText: string | undefined;
    let budget: JsonBudget | undefined;
    return {
      get text() {
        return (prefixText ??= source.toString("utf8", 0, end));
      },
      bytes: end,
      jsonBytes,
      get budget() {
        if (!budget) {
          // JSON escaping is already charged in jsonBytes. Adjust only the changed
          // UTF-8 interval for the model's additive character weights.
          const start = Math.min(measuredEnd, end);
          const finish = Math.max(measuredEnd, end);
          const delta = source.toString("utf8", start, finish);
          const direction = end >= measuredEnd ? 1 : -1;
          extraChars += direction * (estimateToolResultTextChars(delta) - (finish - start));
          extraContextChars +=
            direction *
            (estimateToolResultTextChars(delta, { minimumRawWeight: 2 }) - 2 * (finish - start));
          measuredEnd = end;
          budget = {
            chars: jsonBytes + extraChars,
            contextChars: 2 * jsonBytes + extraContextChars,
          };
        }
        return budget;
      },
    };
  };
}
