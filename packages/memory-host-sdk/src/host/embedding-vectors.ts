// Vector normalization helpers used before embedding similarity search.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { debugEmbeddingsLog } from "./embeddings-debug.js";

/** Validate provider embeddings and restore their original request order. */
export function readEmbeddingVectors(
  data: unknown,
  expectedCount: number | undefined,
  errorPrefix: string,
): number[][] {
  const invalid = (condition: string) =>
    Object.assign(new Error(`${errorPrefix}: ${condition}`), {
      code: "INVALID_EMBEDDING_RESPONSE",
    });
  const first = Array.isArray(data) ? asOptionalRecord(data[0]) : undefined;
  debugEmbeddingsLog("memory embeddings: remote response shape", {
    context: errorPrefix,
    vectorCount: Array.isArray(data) ? data.length : undefined,
    firstVectorDimensions: Array.isArray(first?.embedding) ? first.embedding.length : undefined,
    firstIndexType: typeof first?.index,
  });
  if (!Array.isArray(data)) {
    throw invalid("missing data array");
  }
  if (expectedCount !== undefined && data.length !== expectedCount) {
    throw invalid(
      data.length === 0
        ? `empty data array; expected ${expectedCount} vectors`
        : `expected ${expectedCount} vectors, got ${data.length}`,
    );
  }
  const vectors: number[][] = [];
  let indexed: boolean | undefined;
  for (let position = 0; position < data.length; position += 1) {
    const entry = asOptionalRecord(data[position]);
    const embedding = entry?.embedding;
    const usesIndex = entry?.index !== undefined;
    if (!Array.isArray(embedding)) {
      throw invalid(`missing embedding array at position ${position}`);
    }
    if (embedding.length === 0) {
      throw invalid(`empty embedding at position ${position}`);
    }
    if (indexed !== undefined && indexed !== usesIndex) {
      throw invalid(
        `missing index at position ${usesIndex ? 0 : position} (mixed indexed and positional entries)`,
      );
    }
    for (const [coordinateIndex, coordinate] of embedding.entries()) {
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
        const condition = typeof coordinate === "number" ? "non-finite" : "non-numeric";
        throw invalid(
          `${condition} coordinate at position ${position}, coordinate ${coordinateIndex}`,
        );
      }
    }
    indexed = usesIndex;
    const index = usesIndex ? entry?.index : position;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= data.length
    ) {
      throw invalid(
        `invalid index at position ${position}; expected an integer in [0, ${data.length - 1}]`,
      );
    }
    if (vectors[index] !== undefined) {
      throw invalid(`duplicate index ${index} at position ${position}`);
    }
    vectors[index] = embedding;
  }
  return vectors;
}

/** Replace invalid coordinates and L2-normalize non-empty vectors. */
export function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) {
    return sanitized;
  }
  return sanitized.map((value) => value / magnitude);
}
