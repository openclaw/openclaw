// Preserve binary64 precision and prefix cosine semantics without decoding each row.
export function createEmbeddingScorer(queryVec: number[]): (blob: Uint8Array) => number {
  const queryNorms = new Float64Array(queryVec.length + 1);
  let querySquaredNorm = 0;
  for (let i = 0; i < queryVec.length; i += 1) {
    const value = queryVec[i] ?? 0;
    querySquaredNorm += value * value;
    queryNorms[i + 1] = Math.sqrt(querySquaredNorm);
  }
  return (blob) => {
    if (blob.byteLength % 8 !== 0) {
      return 0;
    }
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const count = blob.byteLength / 8;
    const length = Math.min(count, queryVec.length);
    let dot = 0;
    let normB = 0;
    for (let i = 0; i < count; i += 1) {
      const value = view.getFloat64(i * 8, true);
      // Even an unused tail coordinate must be valid, matching the storage decoder.
      if (!Number.isFinite(value)) {
        return 0;
      }
      if (i < length) {
        dot += (queryVec[i] ?? 0) * value;
        normB += value * value;
      }
    }
    const normA = queryNorms[length] ?? 0;
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dot / (normA * Math.sqrt(normB));
  };
}
