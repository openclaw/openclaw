/**
 * Scores stored binary64 little-endian embedding blobs against one query without
 * materializing a `number[]` per row. Accumulation order, the query-prefix norm
 * and the "any non-finite coordinate makes the row inert (score 0)" rule match
 * `cosineSimilarity(query, decodeMemoryEmbedding(blob))` bit for bit.
 */
export function createEmbeddingScorer(queryVec: number[]): (blob: Uint8Array) => number {
  const queryLength = queryVec.length;
  const prefixNormA = (length: number): number => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) {
      const value = queryVec[i] ?? 0;
      sum += value * value;
    }
    return sum;
  };
  const fullNormA = prefixNormA(queryLength);
  return (blob) => {
    if (blob.byteLength % 8 !== 0) {
      return 0;
    }
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const count = blob.byteLength / 8;
    const length = count < queryLength ? count : queryLength;
    let dot = 0;
    let normB = 0;
    let probe = 0;
    for (let i = 0; i < length; i += 1) {
      const value = view.getFloat64(i * 8, true);
      dot += (queryVec[i] ?? 0) * value;
      normB += value * value;
      probe += value - value; // 0 for finite values, NaN for NaN and +-Infinity
    }
    for (let i = length; i < count; i += 1) {
      const tail = view.getFloat64(i * 8, true);
      probe += tail - tail;
    }
    if (probe !== 0) {
      // A non-finite coordinate makes the stored vector unusable, as in decodeMemoryEmbedding.
      return 0;
    }
    const normA = length === queryLength ? fullNormA : prefixNormA(length);
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  };
}
